import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureRuntimeParityCell,
  runRuntimeParityScenario,
  type RuntimeId,
  type RuntimeParityCell,
  type RuntimeParityToolCall,
} from "./runtime-parity.js";

const tempRoots: string[] = [];

function makeToolCall(overrides: Partial<RuntimeParityToolCall> = {}): RuntimeParityToolCall {
  return {
    tool: "read_file",
    argsHash: "args-a",
    resultHash: "result-a",
    ...overrides,
  };
}

function makeCell(
  runtime: RuntimeId,
  overrides: Partial<RuntimeParityCell> = {},
): RuntimeParityCell {
  return {
    runtime,
    transcriptBytes: '{"message":{"role":"assistant","content":"same reply"}}\n',
    toolCalls: [],
    finalText: "same reply",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
    wallClockMs: 25,
    bootStateLines: [],
    ...overrides,
  };
}

function normalizeVolatileRuntimeStringForTest(value: string) {
  return value
    .replaceAll(/\/(?:private\/)?tmp\/openclaw\/openclaw-qa-suite-[^/\s"',)]+/gu, "<qa-temp>")
    .replaceAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, "<uuid>")
    .replaceAll(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/gu, "<timestamp>")
    .replaceAll(/EXTERNAL_UNTRUSTED_CONTENT id="[^"]+"/gu, 'EXTERNAL_UNTRUSTED_CONTENT id="<id>"')
    .replaceAll(/MEDIA:[^\s"')]+/gu, "MEDIA:<media>");
}

function normalizeForStableHashForTest(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeVolatileRuntimeStringForTest(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForStableHashForTest(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted((left, right) => left.localeCompare(right))
        .map((key) => [key, normalizeForStableHashForTest(record[key])]),
    );
  }
  return value;
}

function stableHashForTest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(normalizeForStableHashForTest(value)) ?? "null")
    .digest("hex");
}

async function createRuntimeParityGatewayTempRoot(transcriptBytes: string) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-parity-"));
  tempRoots.push(tempRoot);
  const sessionsDir = path.join(tempRoot, "state", "agents", "qa", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({
      "session-1": {
        sessionId: "session-1",
        sessionFile: "session-1.jsonl",
        updatedAt: 1,
      },
    }),
    "utf8",
  );
  await fs.writeFile(path.join(sessionsDir, "session-1.jsonl"), transcriptBytes, "utf8");
  return tempRoot;
}

async function createRuntimeParityGatewayTempRootWithSessions(params: {
  sessions: Record<string, Record<string, unknown>>;
  transcripts: Record<string, string>;
}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-parity-"));
  tempRoots.push(tempRoot);
  const sessionsDir = path.join(tempRoot, "state", "agents", "qa", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify(params.sessions),
    "utf8",
  );
  await Promise.all(
    Object.entries(params.transcripts).map(([file, transcript]) =>
      fs.writeFile(path.join(sessionsDir, file), transcript, "utf8"),
    ),
  );
  return tempRoot;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((tempRoot) => fs.rm(tempRoot, { recursive: true, force: true })),
  );
  vi.unstubAllGlobals();
});

describe("runtime parity", () => {
  it("classifies identical cells as none", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "same",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: makeCell(runtime),
      }),
    });

    expect(result.drift).toBe("none");
  });

  it("classifies final-text-only differences as text-only", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "text-only",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: makeCell(runtime, {
          finalText: runtime === "pi" ? "hello from pi" : "hello from codex",
        }),
      }),
    });

    expect(result.drift).toBe("text-only");
  });

  it("classifies tool call shape drift", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "tool-call-shape",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: makeCell(runtime, {
          toolCalls: [makeToolCall(runtime === "pi" ? {} : { argsHash: "args-b" })],
        }),
      }),
    });

    expect(result.drift).toBe("tool-call-shape");
    expect(result.toolBreakdown).toEqual([
      expect.objectContaining({
        tool: "read_file",
        drift: "tool-call-shape",
        piCount: 1,
        codexCount: 1,
      }),
    ]);
  });

  it("ignores Codex-native workspace dynamic call-shape differences", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "codex-native-workspace",
      comparisonMode: "codex-native-workspace",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: makeCell(runtime, {
          transcriptBytes:
            runtime === "pi"
              ? '{"message":{"role":"assistant"}}\n{"message":{"role":"tool"}}\n'
              : '{"message":{"role":"assistant"}}\n',
          toolCalls: runtime === "pi" ? [makeToolCall({ tool: "read" })] : [],
          finalText: runtime === "pi" ? "read completed" : "read completed",
        }),
      }),
    });

    expect(result.drift).toBe("none");
    expect(result.toolBreakdown).toEqual([
      expect.objectContaining({
        tool: "read",
        drift: "tool-call-shape",
        piCount: 1,
        codexCount: 0,
      }),
    ]);
  });

  it("ignores structural transcript differences in outcome-only mode", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "outcome-only",
      comparisonMode: "outcome-only",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: makeCell(runtime, {
          transcriptBytes:
            runtime === "pi"
              ? '{"message":{"role":"assistant"}}\n{"message":{"role":"assistant"}}\n'
              : '{"message":{"role":"assistant"}}\n',
          finalText: "same user-visible outcome",
        }),
      }),
    });

    expect(result.drift).toBe("none");
  });

  it("ignores runtime-specific boot metadata when comparable messages match", async () => {
    const piBootRows = [
      '{"type":"model_change","modelId":"gpt-5.5"}',
      '{"type":"thinking_level_change","thinkingLevel":"off"}',
      '{"type":"custom","customType":"model-snapshot"}',
    ].join("\n");
    const comparableMessages =
      '{"message":{"role":"user","content":"marker"}}\n' +
      '{"message":{"role":"assistant","content":"same user-visible outcome"}}\n';

    const result = await runRuntimeParityScenario({
      scenarioId: "runtime-boot-metadata",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: makeCell(runtime, {
          transcriptBytes:
            runtime === "pi" ? `${piBootRows}\n${comparableMessages}` : comparableMessages,
          finalText: "same user-visible outcome",
        }),
      }),
    });

    expect(result.drift).toBe("none");
  });

  it("classifies tool result shape drift", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "tool-result-shape",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: makeCell(runtime, {
          toolCalls: [makeToolCall(runtime === "pi" ? {} : { resultHash: "result-b" })],
        }),
      }),
    });

    expect(result.drift).toBe("tool-result-shape");
  });

  it("compares matching tool-result errors by failure mode instead of volatile text", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "tool-result-error-mode",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: makeCell(runtime, {
          toolCalls: [
            makeToolCall({
              tool: "web_search",
              resultHash: runtime === "pi" ? "structured-error" : "plain-error",
              errorClass: "tool-result-error",
            }),
          ],
        }),
      }),
    });

    expect(result.drift).toBe("none");
  });

  it("normalizes volatile session_status result decorations", async () => {
    const piRoot = await createRuntimeParityGatewayTempRoot(
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "session_status", input: {} }],
          },
        }),
        JSON.stringify({
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "session_status",
            content:
              "🦞 OpenClaw 2026.5.10-beta.1 ⏱️ Uptime: gateway 14s · system 18h 40m 🧠 Model: openai/gpt-5.5 · 🔑 api-key (qa) 🧮 Tokens: 64 in / 16 out · 💵 Cost: $0.0000 📚 Context: 6/128k (0%) 🧵 Session: agent:qa",
          },
        }),
      ].join("\n"),
    );
    const codexRoot = await createRuntimeParityGatewayTempRoot(
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "session_status", input: {} }],
          },
        }),
        JSON.stringify({
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "session_status",
            content:
              "🦞 OpenClaw 2026.5.10-beta.1 ⏱️ Uptime: gateway 21s · system 18h 42m 🧠 Model: openai/gpt-5.5 📚 Context: 0/128k (0%) 🧵 Session: agent:qa",
          },
        }),
      ].join("\n"),
    );

    const result = await runRuntimeParityScenario({
      scenarioId: "session-status-volatile",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: await captureRuntimeParityCell({
          runtime,
          gateway: { tempRoot: runtime === "pi" ? piRoot : codexRoot },
          scenarioResult: { status: "pass" },
          wallClockMs: 1,
        }),
      }),
    });

    expect(result.drift).toBe("none");
  });

  it("normalizes volatile external-content ids in web_fetch results", async () => {
    const piRoot = await createRuntimeParityGatewayTempRoot(
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "web_fetch",
                input: { url: "https://example.com/" },
              },
            ],
          },
        }),
        JSON.stringify({
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "web_fetch",
            content: '<<<EXTERNAL_UNTRUSTED_CONTENT id="abc123">>>Example Domain',
          },
        }),
      ].join("\n"),
    );
    const codexRoot = await createRuntimeParityGatewayTempRoot(
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "web_fetch",
                input: { url: "https://example.com/" },
              },
            ],
          },
        }),
        JSON.stringify({
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "web_fetch",
            content: '<<<EXTERNAL_UNTRUSTED_CONTENT id="def456">>>Example Domain',
          },
        }),
      ].join("\n"),
    );

    const result = await runRuntimeParityScenario({
      scenarioId: "web-fetch-volatile",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: await captureRuntimeParityCell({
          runtime,
          gateway: { tempRoot: runtime === "pi" ? piRoot : codexRoot },
          scenarioResult: { status: "pass" },
          wallClockMs: 1,
        }),
      }),
    });

    expect(result.drift).toBe("none");
  });

  it("compares tool calls as a multiset so separate session capture order is stable", async () => {
    const first = makeToolCall({ tool: "sessions_spawn", argsHash: "args-a" });
    const second = makeToolCall({ tool: "sessions_spawn", argsHash: "args-b" });
    const result = await runRuntimeParityScenario({
      scenarioId: "tool-call-multiset",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: makeCell(runtime, {
          toolCalls: runtime === "pi" ? [first, second] : [second, first],
        }),
      }),
    });

    expect(result.drift).toBe("none");
  });

  it("classifies transcript-structure drift", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "structural",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: makeCell(runtime, {
          transcriptBytes:
            runtime === "pi"
              ? '{"message":{"role":"assistant"}}\n'
              : '{"message":{"role":"assistant"}}\n{"message":{"role":"tool"}}\n',
        }),
      }),
    });

    expect(result.drift).toBe("structural");
  });

  it("classifies runtime failures before other drift types", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "failure-mode",
      runCell: async (runtime) => ({
        scenarioStatus: runtime === "pi" ? "fail" : "pass",
        cell: makeCell(runtime, runtime === "pi" ? { runtimeErrorClass: "timeout" } : {}),
      }),
    });

    expect(result.drift).toBe("failure-mode");
  });

  it("surfaces tool-call-shape when one runtime fails because the tool path drifted", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "tool-call-failure",
      runCell: async (runtime) => ({
        scenarioStatus: runtime === "pi" ? "pass" : "fail",
        cell: makeCell(runtime, {
          toolCalls: runtime === "pi" ? [makeToolCall()] : [],
          ...(runtime === "codex" ? { runtimeErrorClass: "tool-error" } : {}),
        }),
      }),
    });

    expect(result.drift).toBe("tool-call-shape");
  });

  it("surfaces tool-result-shape when a downstream timeout follows divergent tool output", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "tool-result-timeout",
      runCell: async (runtime) => ({
        scenarioStatus: runtime === "pi" ? "pass" : "fail",
        cell: makeCell(runtime, {
          toolCalls: [makeToolCall(runtime === "pi" ? {} : { resultHash: "result-b" })],
          ...(runtime === "codex" ? { runtimeErrorClass: "timeout" } : {}),
        }),
      }),
    });

    expect(result.drift).toBe("tool-result-shape");
  });

  it("captures provider-side mock request snapshots separately from runtime tool calls", async () => {
    const tempRoot = await createRuntimeParityGatewayTempRoot('{"message":{"role":"assistant"}}\n');
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            plannedToolName: "read",
            plannedToolArgs: { path: "QA_KICKOFF_TASK.md" },
            toolOutput: "",
          },
          {
            toolOutput: JSON.stringify({
              status: "ok",
              text: "QA mission: Understand this OpenClaw repo from source + docs before acting.",
            }),
          },
        ],
      }),
    );

    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: {
        tempRoot,
      },
      scenarioResult: {
        status: "pass",
      },
      wallClockMs: 42,
      mockBaseUrl: "http://127.0.0.1:9999",
    });

    expect(cell.toolCalls).toEqual([]);
    expect(cell.providerPlanToolCalls).toEqual([
      {
        tool: "read",
        argsHash: stableHashForTest({ path: "QA_KICKOFF_TASK.md" }),
        resultHash: stableHashForTest({
          status: "ok",
          text: "QA mission: Understand this OpenClaw repo from source + docs before acting.",
        }),
      },
    ]);
  });

  it("keeps chained provider-side tool plans diagnostic instead of classifier-authoritative", async () => {
    const tempRoot = await createRuntimeParityGatewayTempRoot('{"message":{"role":"assistant"}}\n');
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            plannedToolName: "read",
            plannedToolArgs: { path: "audit-fixture/README.md" },
            toolOutput: "",
          },
          {
            toolOutput: JSON.stringify({
              status: "ok",
              text: "Release readiness task",
            }),
            plannedToolName: "write",
            plannedToolArgs: { path: "release-audit.json", content: "{}" },
          },
          {
            toolOutput: JSON.stringify({
              status: "failed",
              error: "permission denied",
            }),
          },
        ],
      }),
    );

    const cell = await captureRuntimeParityCell({
      runtime: "pi",
      gateway: {
        tempRoot,
      },
      scenarioResult: {
        status: "pass",
      },
      wallClockMs: 42,
      mockBaseUrl: "http://127.0.0.1:9999",
    });

    expect(cell.toolCalls).toEqual([]);
    expect(cell.providerPlanToolCalls).toEqual([
      {
        tool: "read",
        argsHash: stableHashForTest({ path: "audit-fixture/README.md" }),
        resultHash: stableHashForTest({
          status: "ok",
          text: "Release readiness task",
        }),
      },
      {
        tool: "write",
        argsHash: stableHashForTest({ content: "{}", path: "release-audit.json" }),
        resultHash: stableHashForTest({
          status: "failed",
          error: "permission denied",
        }),
        errorClass: "tool-result-error",
      },
    ]);
  });

  it("associates Codex-style toolResult records by toolCallId", async () => {
    const tempRoot = await createRuntimeParityGatewayTempRoot(
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "web_search",
                input: { query: "openclaw" },
              },
            ],
          },
        }),
        JSON.stringify({
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "web_search",
            content: { status: "ok", results: [] },
          },
        }),
      ].join("\n"),
    );

    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: {
        tempRoot,
      },
      scenarioResult: {
        status: "pass",
      },
      wallClockMs: 42,
    });

    expect(cell.toolCalls).toEqual([
      {
        tool: "web_search",
        argsHash: stableHashForTest({ query: "openclaw" }),
        resultHash: stableHashForTest({ status: "ok", results: [] }),
      },
    ]);
  });

  it("normalizes per-cell QA temp roots before hashing runtime tool arguments", async () => {
    const tempRoot = await createRuntimeParityGatewayTempRoot(
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "bash",
                input: {
                  command: "/bin/zsh -lc \"sed -n '1,160p' QA_KICKOFF_TASK.md\"",
                  cwd: "/private/tmp/openclaw/openclaw-qa-suite-AbCd12/workspace",
                },
              },
            ],
          },
        }),
        JSON.stringify({
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "bash",
            content: {
              status: "ok",
              cwd: "/tmp/openclaw/openclaw-qa-suite-EfGh34/workspace",
            },
          },
        }),
      ].join("\n"),
    );

    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: {
        tempRoot,
      },
      scenarioResult: {
        status: "pass",
      },
      wallClockMs: 42,
    });

    expect(cell.toolCalls).toEqual([
      {
        tool: "bash",
        argsHash: stableHashForTest({
          command: "/bin/zsh -lc \"sed -n '1,160p' QA_KICKOFF_TASK.md\"",
          cwd: "<qa-temp>/workspace",
        }),
        resultHash: stableHashForTest({
          status: "ok",
          cwd: "<qa-temp>/workspace",
        }),
      },
    ]);
  });

  it("normalizes Codex toolResult blocks before hashing runtime results", async () => {
    const tempRoot = await createRuntimeParityGatewayTempRoot(
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "web_search",
                input: { query: "openclaw" },
              },
            ],
          },
        }),
        JSON.stringify({
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "web_search",
            isError: true,
            content: [
              {
                type: "toolResult",
                toolCallId: "call-1",
                toolName: "web_search",
                content: "web_search is disabled or no provider is available.",
              },
            ],
          },
        }),
      ].join("\n"),
    );

    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: {
        tempRoot,
      },
      scenarioResult: {
        status: "pass",
      },
      wallClockMs: 42,
    });

    expect(cell.toolCalls).toEqual([
      {
        tool: "web_search",
        argsHash: stableHashForTest({ query: "openclaw" }),
        resultHash: stableHashForTest({
          status: "error",
          tool: "web_search",
          error: "provider-disabled",
        }),
        errorClass: "tool-result-error",
      },
    ]);
  });

  it("excludes spawned child sessions from parent parity capture", async () => {
    const tempRoot = await createRuntimeParityGatewayTempRootWithSessions({
      sessions: {
        parent: {
          sessionId: "parent",
          sessionFile: "parent.jsonl",
          updatedAt: 1,
        },
        child: {
          sessionId: "child",
          sessionFile: "child.jsonl",
          updatedAt: 2,
          spawnedBy: "agent:qa:main",
          spawnDepth: 1,
        },
      },
      transcripts: {
        "parent.jsonl": JSON.stringify({
          message: { role: "assistant", content: [{ type: "text", text: "parent final" }] },
        }),
        "child.jsonl": JSON.stringify({
          message: { role: "assistant", content: [{ type: "text", text: "child final" }] },
        }),
      },
    });

    const cell = await captureRuntimeParityCell({
      runtime: "pi",
      gateway: { tempRoot },
      scenarioResult: { status: "pass" },
      wallClockMs: 10,
    });

    expect(cell.finalText).toBe("parent final");
    expect(cell.transcriptBytes).not.toContain("child final");
  });

  it("captures codex plugin state from the QA agent directory", async () => {
    const tempRoot = await createRuntimeParityGatewayTempRoot('{"message":{"role":"assistant"}}\n');
    const pluginDir = path.join(tempRoot, "state", "agents", "qa", "agent", "plugins", "codex");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ version: "2026.5.10-beta.1" }),
      "utf8",
    );

    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: {
        tempRoot,
      },
      scenarioResult: {
        status: "pass",
      },
      wallClockMs: 42,
    });

    expect(cell.pluginState).toEqual({
      codex: {
        installed: true,
        version: "2026.5.10-beta.1",
      },
    });
  });
});
