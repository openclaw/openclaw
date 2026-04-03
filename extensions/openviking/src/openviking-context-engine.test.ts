import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWorkspaceWritebackBlock,
  buildSystemPromptAddition,
  buildWritebackRelativePath,
  createWritebackDigest,
  extractLatestTurn,
  extractLatestUserQuery,
  extractWritebackCandidate,
  OpenVikingContextEngine,
  extractTextContent,
  normalizeBaseUrl,
  resolveWorkspaceChild,
} from "./openviking-context-engine.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function userMessage(content: string): AgentMessage {
  return {
    role: "user",
    content,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function assistantMessage(content: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: "responses",
    provider: "test",
    model: "test",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cost: 0,
    },
    stopReason: "end_turn",
    timestamp: Date.now(),
    id: "assistant-test",
  } as unknown as AgentMessage;
}

describe("normalizeBaseUrl", () => {
  it("drops trailing slashes", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:1933///")).toBe("http://127.0.0.1:1933");
  });
});

describe("extractTextContent", () => {
  it("reads plain string content", () => {
    expect(extractTextContent(" hello ")).toBe("hello");
  });

  it("joins text blocks", () => {
    expect(
      extractTextContent([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
  });
});

describe("extractLatestUserQuery", () => {
  it("returns the latest non-empty user text", () => {
    expect(
      extractLatestUserQuery([
        userMessage("older"),
        assistantMessage("ignored"),
        userMessage("latest question"),
      ]),
    ).toBe("latest question");
  });
});

describe("buildSystemPromptAddition", () => {
  it("formats retrieved snippets for prompt injection", () => {
    const output = buildSystemPromptAddition({
      header: "Retrieved context from OpenViking.",
      query: "How did we fix Feishu logs?",
      snippets: [
        {
          uri: "viking://resources/openclaw/native/MEMORY.md",
          score: 0.82,
          abstract: "Summary",
          text: "Longer excerpt",
        },
      ],
    });
    expect(output).toContain("Retrieved context from OpenViking.");
    expect(output).toContain("User query:");
    expect(output).toContain("Result 1: viking://resources/openclaw/native/MEMORY.md");
    expect(output).toContain("Score: 0.820");
    expect(output).toContain("Excerpt:\nLonger excerpt");
  });
});

describe("writeback helpers", () => {
  it("extracts the latest user/assistant turn", () => {
    expect(
      extractLatestTurn([
        userMessage("first"),
        assistantMessage("ignore me"),
        userMessage("What should we remember?"),
        assistantMessage("Always create the doc before appending content."),
      ]),
    ).toEqual({
      query: "What should we remember?",
      answer: "Always create the doc before appending content.",
    });
  });

  it("builds a stable writeback candidate digest", () => {
    const candidate = extractWritebackCandidate(
      [
        userMessage("Remember this preference."),
        assistantMessage("Use OpenViking for unified retrieval."),
      ],
      200,
    );
    expect(candidate).toEqual({
      query: "Remember this preference.",
      answer: "Use OpenViking for unified retrieval.",
      digest: createWritebackDigest(
        "Remember this preference.",
        "Use OpenViking for unified retrieval.",
      ),
    });
  });

  it("keeps workspace writeback paths inside the workspace", () => {
    const relative = buildWritebackRelativePath(
      "memory/openviking",
      new Date("2026-03-23T01:02:03Z"),
    );
    expect(relative).toBe("memory/openviking/2026-03-23.md");
    expect(resolveWorkspaceChild("/tmp/workspace", relative)).toBe(
      path.resolve("/tmp/workspace", "memory/openviking/2026-03-23.md"),
    );
    expect(() => resolveWorkspaceChild("/tmp/workspace", "../escape.md")).toThrow(
      "writeback path escapes workspace",
    );
  });

  it("keeps OpenViking writebacks scoped to native memory", () => {
    expect(() =>
      buildWritebackRelativePath("ObsidianVault/30-Knowledge", new Date("2026-03-23T01:02:03Z")),
    ).toThrow("writebackDirectory must stay under memory/");
    expect(() =>
      buildWritebackRelativePath("memory/.obsidian", new Date("2026-03-23T01:02:03Z")),
    ).toThrow("writebackDirectory must not target .obsidian");
  });

  it("formats a workspace writeback block", () => {
    const block = buildWorkspaceWritebackBlock({
      marker: "<!-- openviking-writeback:abc123 -->",
      sessionId: "s1",
      sessionKey: "agent/main",
      query: "What changed?",
      answer: "We switched retrieval to OpenViking.",
      timestamp: new Date("2026-03-23T00:00:00Z"),
    });
    expect(block).toContain("<!-- openviking-writeback:abc123 -->");
    expect(block).toContain("### User");
    expect(block).toContain("### Assistant");
  });
});

describe("OpenVikingContextEngine.afterTurn", () => {
  it("writes back through the session API and workspace mirror in hybrid mode", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openviking-engine-"));
    const expectedDate = new Date().toISOString().slice(0, 10);
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/sessions")) {
        return new Response(JSON.stringify({ result: { session_id: "session-123" } }), {
          status: 200,
        });
      }
      if (url.includes("/api/v1/sessions/session-123/messages")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/api/v1/sessions/session-123/commit")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url} ${JSON.stringify(init?.body ?? null)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = new OpenVikingContextEngine(
      {
        baseUrl: "http://127.0.0.1:1933",
        writebackEnabled: true,
        writebackMode: "hybrid",
        writebackDirectory: "memory/openviking",
      },
      {
        info() {},
        warn() {},
        error() {},
      },
    );

    await engine.afterTurn({
      sessionId: "session-main",
      sessionKey: "agent/main",
      sessionFile: "/tmp/fake.jsonl",
      prePromptMessageCount: 0,
      messages: [
        userMessage("Remember the Feishu fix."),
        assistantMessage("Create the empty doc first, then append blocks."),
      ],
      runtimeContext: { workspaceDir },
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const written = await fs.readFile(
      path.join(workspaceDir, `memory/openviking/${expectedDate}.md`),
      "utf-8",
    );
    expect(written).toContain("Remember the Feishu fix.");
    expect(written).toContain("Create the empty doc first, then append blocks.");

    const diagnostic = JSON.parse(
      await fs.readFile(path.join(workspaceDir, "memory/openviking/_status.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(diagnostic.writebackMode).toBe("hybrid");
    expect(diagnostic.writebackDigest).toBeTypeOf("string");
    const index = JSON.parse(
      await fs.readFile(
        path.join(workspaceDir, "memory/openviking/_writeback-index.json"),
        "utf-8",
      ),
    ) as { digests: string[] };
    expect(index.digests).toHaveLength(1);
  });

  it("skips duplicate writebacks across engine restarts with a persisted index", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openviking-engine-"));
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/v1/sessions")) {
        return new Response(JSON.stringify({ result: { session_id: "session-123" } }), {
          status: 200,
        });
      }
      if (url.includes("/api/v1/sessions/session-123/messages")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/api/v1/sessions/session-123/commit")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const config = {
      baseUrl: "http://127.0.0.1:1933",
      writebackEnabled: true,
      writebackMode: "hybrid" as const,
      writebackDirectory: "memory/openviking",
    };
    const turn = {
      sessionId: "session-main",
      sessionKey: "agent/main",
      sessionFile: "/tmp/fake.jsonl",
      prePromptMessageCount: 0,
      messages: [
        userMessage("Remember the Feishu fix."),
        assistantMessage("Create the empty doc first, then append blocks."),
      ],
      runtimeContext: { workspaceDir },
    };

    await new OpenVikingContextEngine(config).afterTurn(turn);
    await new OpenVikingContextEngine(config).afterTurn(turn);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const dailyPath = path.join(
      workspaceDir,
      `memory/openviking/${new Date().toISOString().slice(0, 10)}.md`,
    );
    const written = await fs.readFile(dailyPath, "utf-8");
    expect(written.match(/openviking-writeback:/g)).toHaveLength(1);

    const diagnostic = JSON.parse(
      await fs.readFile(path.join(workspaceDir, "memory/openviking/_status.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(diagnostic.writebackSkipped).toBe("duplicate digest (persisted index)");
  });

  it("skips diagnostic snapshots that point outside native memory", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openviking-engine-"));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = new OpenVikingContextEngine(
      {
        diagnosticFile: "ObsidianVault/status.json",
      },
      logger,
    );

    await engine.afterTurn({
      sessionId: "session-main",
      sessionFile: "/tmp/fake.jsonl",
      prePromptMessageCount: 0,
      messages: [userMessage("hello"), assistantMessage("world")],
      runtimeContext: { workspaceDir },
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("openviking: diagnostic snapshot skipped"),
    );
  });
});
