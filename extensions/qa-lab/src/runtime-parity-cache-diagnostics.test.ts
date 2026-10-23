import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeQaRuntimeStores } from "openclaw/plugin-sdk/qa-runtime";
import { resolveStorePath, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { formatSqliteSessionFileMarker as sessionMarker } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, expect, it } from "vitest";
import { buildRuntimeParityCacheDiagnostics } from "./runtime-parity-cache-diagnostics.js";
import {
  captureRuntimeParityCell as captureCell,
  type RuntimeParityUsage,
} from "./runtime-parity.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness({ beforeCleanup: closeQaRuntimeStores });

afterEach(() => resetPluginStateStoreForTests({ closeDatabase: false }));
afterAll(() => tempDirs.cleanup());

async function captureCacheTranscript(
  turns: Array<Record<string, unknown>>,
  runtime: "openclaw" | "codex" = "openclaw",
) {
  const tempRoot = await tempDirs.makeTempDir("openclaw-qa-runtime-parity-cache-");
  const agentId = "qa";
  const sessionId = "runtime-parity-cache-miss";
  const sessionKey = "agent:qa:runtime-parity-cache-miss";
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(tempRoot, "state") };
  const storePath = resolveStorePath(undefined, { agentId, env });
  const identity = { agentId, env, sessionKey, storePath };
  const sessionFile = sessionMarker({ agentId, sessionId, storePath });
  await upsertSessionEntry({ ...identity, entry: { sessionId, sessionFile, updatedAt: 100 } });
  const messages = turns.flatMap((turn) => [
    { role: "user", content: "Continue." },
    { role: "assistant", content: "done", ...turn },
  ]);
  for (const [index, message] of messages.entries()) {
    await appendSessionTranscriptMessageByIdentity({
      ...identity,
      sessionId,
      now: index + 1,
      message: message as never,
    });
  }
  return captureCell({
    runtime,
    gateway: { tempRoot },
    scenarioResult: { status: "pass" },
    wallClockMs: 10,
  });
}

function usage(inputTokens: number, read?: number, write?: number): RuntimeParityUsage {
  const totalTokens = inputTokens + (read ?? 0) + (write ?? 0);
  return { inputTokens, outputTokens: 0, totalTokens, cacheRead: read, cacheWrite: write };
}

it("captures post-warm cache losses from the canonical SQLite assistant transcript", async () => {
  const cell = await captureCacheTranscript(
    [
      { usage: { input: 3, output: 11, total: 24_421, cacheRead: 0, cacheWrite: 24_407 } },
      { usage: { input: 24_448, output: 11, total: 24_459, cacheRead: 0, cacheWrite: 0 } },
    ],
    "codex",
  );

  expect(cell.cacheDiagnostics).toEqual({
    assistantTurns: 2,
    cacheTelemetryTurns: 2,
    cacheHitTurns: 0,
    cacheWriteTurns: 1,
    cacheMisses: [{ turn: 2, inputTokens: 24_448, cacheRead: 0, cacheWrite: 0 }],
    cacheMissInputTokens: 24_448,
    unmeasuredPostWarmTurns: [],
  });
  expect(cell.usage).toMatchObject({
    inputTokens: 24_451,
    outputTokens: 22,
    cacheRead: 0,
    cacheWrite: 24_407,
  });
});

it.each([undefined, { state: "unavailable" as const }])(
  "preserves unavailable Ollama cache telemetry (marker: %j)",
  async (marker) => {
    const cell = await captureCacheTranscript([
      {
        api: "ollama",
        provider: "ollama",
        model: "qwen3.5:9b",
        usage: {
          input: 22,
          output: 7,
          total: 29,
          cacheRead: 0,
          cacheWrite: 0,
          ...(marker ? { cacheTelemetry: marker } : {}),
        },
      },
    ]);
    expect(cell.usage).toEqual({ inputTokens: 22, outputTokens: 7, totalTokens: 29 });
    expect(cell.cacheDiagnostics).toEqual({
      assistantTurns: 1,
      cacheTelemetryTurns: 0,
      cacheHitTurns: 0,
      cacheWriteTurns: 0,
      cacheMisses: [],
      cacheMissInputTokens: 0,
      unmeasuredPostWarmTurns: [],
    });
  },
);

it("preserves measured misses without concealing later unmeasured warm turns", () => {
  const diagnostics = buildRuntimeParityCacheDiagnostics([
    usage(3, 0, 1_000),
    usage(1_050, 0, 0),
    usage(1_100),
    usage(12, 1_000),
  ]);

  expect(diagnostics.cacheMisses).toEqual([
    { turn: 2, inputTokens: 1_050, cacheRead: 0, cacheWrite: 0 },
  ]);
  expect(diagnostics).toMatchObject({
    cacheMissInputTokens: 1_050,
    unmeasuredPostWarmTurns: [3, 4],
    cacheHitTurns: 1,
  });
});
