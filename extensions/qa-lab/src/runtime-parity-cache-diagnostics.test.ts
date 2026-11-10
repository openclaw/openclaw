import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeQaRuntimeStores } from "openclaw/plugin-sdk/qa-runtime";
import { afterAll, afterEach, expect, it } from "vitest";
import { captureRuntimeParityCell as captureCell } from "./runtime-parity.js";
import { createRuntimeParityTranscriptHarness } from "./runtime-parity.test-helper.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness({ beforeCleanup: closeQaRuntimeStores });
const { seedRuntimeParityTranscript } = createRuntimeParityTranscriptHarness();

afterEach(() => resetPluginStateStoreForTests({ closeDatabase: false }));
afterAll(() => tempDirs.cleanup());

async function captureCacheTranscript(
  turns: Array<Record<string, unknown>>,
  runtime: "openclaw" | "codex" = "openclaw",
) {
  const tempRoot = await tempDirs.makeTempDir("openclaw-qa-runtime-parity-cache-");
  await seedRuntimeParityTranscript({
    tempRoot,
    sessionId: "runtime-parity-cache-miss",
    sessionKey: "agent:qa:runtime-parity-cache-miss",
    messages: turns.flatMap((turn) => [
      { role: "user", content: "Continue." },
      { role: "assistant", content: "done", ...turn },
    ]),
  });
  return captureCell({
    runtime,
    gateway: { tempRoot },
    scenarioResult: { status: "pass" },
    wallClockMs: 10,
  });
}

it("captures cache misses and subsequent unmeasured warm turns from SQLite", async () => {
  const cell = await captureCacheTranscript(
    [
      { usage: { input: 3, output: 11, total: 24_421, cacheRead: 0, cacheWrite: 24_407 } },
      { usage: { input: 24_448, output: 11, total: 24_459, cacheRead: 0, cacheWrite: 0 } },
      { usage: { input: 1_100, output: 0, total: 1_100 } },
      { usage: { input: 12, output: 0, total: 1_012, cacheRead: 1_000 } },
    ],
    "codex",
  );

  expect(cell.cacheDiagnostics).toEqual({
    assistantTurns: 4,
    cacheTelemetryTurns: 2,
    cacheHitTurns: 1,
    cacheWriteTurns: 1,
    cacheMisses: [{ turn: 2, inputTokens: 24_448, cacheRead: 0, cacheWrite: 0 }],
    cacheMissInputTokens: 24_448,
    unmeasuredPostWarmTurns: [3, 4],
  });
  expect(cell.usage).toMatchObject({
    inputTokens: 25_563,
    outputTokens: 22,
    cacheRead: 1_000,
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
