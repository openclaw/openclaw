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
    transcriptBytes: '{"role":"assistant"}\n',
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

function normalizeForStableHashForTest(value: unknown): unknown {
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
            runtime === "pi" ? '{"role":"assistant"}\n' : '{"role":"assistant"}\n{"role":"tool"}\n',
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
