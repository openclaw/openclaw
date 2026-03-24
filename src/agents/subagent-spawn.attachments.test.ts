import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

const callGatewayMock = vi.fn();

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

let configOverride: Record<string, unknown> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
  tools: {
    sessions_spawn: {
      attachments: {
        enabled: true,
        maxFiles: 50,
        maxFileBytes: 1 * 1024 * 1024,
        maxTotalBytes: 5 * 1024 * 1024,
      },
    },
  },
  agents: {
    defaults: {
      workspace: os.tmpdir(),
    },
  },
};
let workspaceDirOverride = "";
let configPathOverride = "";
let previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;

vi.mock("./subagent-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-registry.js")>();
  return {
    ...actual,
    countActiveRunsForSession: () => 0,
    registerSubagentRun: () => {},
  };
});

vi.mock("./subagent-announce.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-announce.js")>();
  return {
    ...actual,
    buildSubagentSystemPrompt: () => "system-prompt",
  };
});

vi.mock("./agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-scope.js")>();
  return {
    ...actual,
    resolveAgentWorkspaceDir: () => workspaceDirOverride,
  };
});

vi.mock("./subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({ hasHooks: () => false }),
}));

function setupGatewayMock() {
  callGatewayMock.mockImplementation(async (opts: { method?: string; params?: unknown }) => {
    if (opts.method === "sessions.patch") {
      return { ok: true };
    }
    if (opts.method === "sessions.delete") {
      return { ok: true };
    }
    if (opts.method === "agent") {
      return { runId: "run-1" };
    }
    return {};
  });
}

async function loadSubagentSpawnModule() {
  return import("./subagent-spawn.js");
}

// --- decodeStrictBase64 ---

describe("decodeStrictBase64", () => {
  const maxBytes = 1024;

  it("valid base64 returns buffer with correct bytes", async () => {
    const { decodeStrictBase64 } = await loadSubagentSpawnModule();
    const input = "hello world";
    const encoded = Buffer.from(input).toString("base64");
    const result = decodeStrictBase64(encoded, maxBytes);
    expect(result).not.toBeNull();
    expect(result?.toString("utf8")).toBe(input);
  });

  it("empty string returns null", async () => {
    const { decodeStrictBase64 } = await loadSubagentSpawnModule();
    expect(decodeStrictBase64("", maxBytes)).toBeNull();
  });

  it("bad padding (length % 4 !== 0) returns null", async () => {
    const { decodeStrictBase64 } = await loadSubagentSpawnModule();
    expect(decodeStrictBase64("abc", maxBytes)).toBeNull();
  });

  it("non-base64 chars returns null", async () => {
    const { decodeStrictBase64 } = await loadSubagentSpawnModule();
    expect(decodeStrictBase64("!@#$", maxBytes)).toBeNull();
  });

  it("whitespace-only returns null (empty after strip)", async () => {
    const { decodeStrictBase64 } = await loadSubagentSpawnModule();
    expect(decodeStrictBase64("   ", maxBytes)).toBeNull();
  });

  it("pre-decode oversize guard: encoded string > maxEncodedBytes * 2 returns null", async () => {
    const { decodeStrictBase64 } = await loadSubagentSpawnModule();
    // maxEncodedBytes = ceil(1024/3)*4 = 1368; *2 = 2736
    const oversized = "A".repeat(2737);
    expect(decodeStrictBase64(oversized, maxBytes)).toBeNull();
  });

  it("decoded byteLength exceeds maxDecodedBytes returns null", async () => {
    const { decodeStrictBase64 } = await loadSubagentSpawnModule();
    const bigBuf = Buffer.alloc(1025, 0x42);
    const encoded = bigBuf.toString("base64");
    expect(decodeStrictBase64(encoded, maxBytes)).toBeNull();
  });

  it("valid base64 at exact boundary returns Buffer", async () => {
    const { decodeStrictBase64 } = await loadSubagentSpawnModule();
    const exactBuf = Buffer.alloc(1024, 0x41);
    const encoded = exactBuf.toString("base64");
    const result = decodeStrictBase64(encoded, maxBytes);
    expect(result).not.toBeNull();
    expect(result?.byteLength).toBe(1024);
  });
});

// --- filename validation via spawnSubagentDirect ---

describe("spawnSubagentDirect filename validation", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockClear();
    setupGatewayMock();
    workspaceDirOverride = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-subagent-attachments-${process.pid}-${Date.now()}-`),
    );
    configPathOverride = path.join(workspaceDirOverride, "openclaw.test.json");
    fs.writeFileSync(configPathOverride, JSON.stringify(configOverride, null, 2));
    previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    process.env.OPENCLAW_CONFIG_PATH = configPathOverride;
  });

  afterEach(() => {
    if (previousConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
    }
    configPathOverride = "";
    if (workspaceDirOverride) {
      fs.rmSync(workspaceDirOverride, { recursive: true, force: true });
      workspaceDirOverride = "";
    }
  });

  const ctx = {
    agentSessionKey: "agent:main:main",
    agentChannel: "telegram" as const,
    agentAccountId: "123",
    agentTo: "456",
  };

  const validContent = Buffer.from("hello").toString("base64");

  async function spawnWithName(name: string) {
    const { spawnSubagentDirect } = await loadSubagentSpawnModule();
    return spawnSubagentDirect(
      {
        task: "test",
        attachments: [{ name, content: validContent, encoding: "base64" }],
      },
      ctx,
    );
  }

  it("name with / returns attachments_invalid_name", async () => {
    const result = await spawnWithName("foo/bar");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("name '..' returns attachments_invalid_name", async () => {
    const result = await spawnWithName("..");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("name '.manifest.json' returns attachments_invalid_name", async () => {
    const result = await spawnWithName(".manifest.json");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("name with newline returns attachments_invalid_name", async () => {
    const result = await spawnWithName("foo\nbar");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("duplicate name returns attachments_duplicate_name", async () => {
    const { spawnSubagentDirect } = await loadSubagentSpawnModule();
    const result = await spawnSubagentDirect(
      {
        task: "test",
        attachments: [
          { name: "file.txt", content: validContent, encoding: "base64" },
          { name: "file.txt", content: validContent, encoding: "base64" },
        ],
      },
      ctx,
    );
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_duplicate_name/);
  });

  it("empty name returns attachments_invalid_name", async () => {
    const result = await spawnWithName("");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("removes materialized attachments when lineage patching fails", async () => {
    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "sessions.patch" && typeof request.params?.spawnedBy === "string") {
        throw new Error("lineage patch failed");
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const { spawnSubagentDirect } = await loadSubagentSpawnModule();
    const result = await spawnSubagentDirect(
      {
        task: "test",
        attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
      },
      ctx,
    );

    expect(result).toMatchObject({
      status: "error",
      error: "lineage patch failed",
    });
    const attachmentsRoot = path.join(workspaceDirOverride, ".openclaw", "attachments");
    const retainedDirs = fs.existsSync(attachmentsRoot)
      ? fs.readdirSync(attachmentsRoot).filter((entry) => !entry.startsWith("."))
      : [];
    expect(retainedDirs).toHaveLength(0);
    const deleteCall = calls.find((entry) => entry.method === "sessions.delete");
    expect(deleteCall?.params).toMatchObject({
      key: expect.stringMatching(/^agent:main:subagent:/),
      deleteTranscript: true,
      emitLifecycleHooks: false,
    });
  });
});
