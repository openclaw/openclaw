/**
 * Logging-owner benchmark. Run unchanged on both revisions in five alternating pairs:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/cheaper-retry-logging.ts \
 *   --scenario chat-send --mode timing --iterations 5000
 * Scenarios: chat-send, disabled-runtime, disabled-context, registry-miss, provider-429.
 * Repeat with --mode allocation for inclusive sampled bytes; sampler timing is not a gate.
 * Provider-429 uses the real Responses SDK/transport and an in-process HTTP 429 fixture,
 * with 40 tool definitions. Console bytes are captured after real logger formatting;
 * they exclude retry-controller scheduling and are not whole-Gateway journal throughput.
 * Accept fewer owner operations and lower CPU/allocation with unchanged error/redaction
 * behavior; Gateway correctness and journal-volume evidence remain a separate run.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { Model } from "@openclaw/llm-core";
import { Type } from "typebox";
import { configureAiTransportHost, getAiTransportHost } from "../../packages/ai/src/host.js";
import { createOpenAIResponsesTransportStreamFn } from "../../packages/ai/src/transports/openai-responses-client.js";
import { startChatSendDiagnostics } from "../../src/gateway/server-methods/chat-send-diagnostics.js";
import { setDiagnosticsEnabledForProcess } from "../../src/infra/diagnostic-events.js";
import "../../src/llm/ai-transport-host.js";
import { withModelTransportContext } from "../../src/llm/model-transport-context.js";
import { setLoggerOverride } from "../../src/logging/logger.js";
import {
  redactRegisteredSecretValues,
  registerSecretValueForRedaction,
} from "../../src/logging/secret-redaction-registry.js";
import { loggingState } from "../../src/logging/state.js";
import { createSubsystemLogger, runtimeForLogger } from "../../src/logging/subsystem.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    scenario: { type: "string", default: "all" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "5000" },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 5000,
});
assert(["timing", "allocation", "both"].includes(values.mode));
let scenario = values.scenario;
assert(
  [
    "all",
    "chat-send",
    "disabled-runtime",
    "disabled-context",
    "registry-miss",
    "provider-429",
  ].includes(values.scenario),
);
assert(globalThis.gc, "Run with --expose-gc");
for (const suffix of ["MODEL_TRANSPORT", "MODEL_PAYLOAD", "SSE", "CODE_MODE"]) {
  delete process.env[`OPENCLAW_DEBUG_${suffix}`];
}
setDiagnosticsEnabledForProcess(false);
setLoggerOverride({
  level: "silent",
  consoleLevel: "silent",
  consoleStyle: "json",
});
let logLines = 0;
let logBytes = 0;
let requests = 0;
let failures = 0;
let reports = 0;
const capture = (...args: unknown[]) => {
  assert(
    args.every((arg) => typeof arg === "string"),
    "Console sink must receive rendered text",
  );
  logLines++;
  logBytes += Buffer.byteLength(args.join(" ")) + 1;
};
loggingState.rawConsole = { log: capture, info: capture, warn: capture, error: capture };
const details = Array.from({ length: 40 }, (_, index) => `plugin_${index}.prepare`);
const structured = {
  sessionKey: "agent:synthetic:subagent:fixture",
  runId: "fixture-run",
  plugins: details.map((name) => ({ name, enabled: true, elapsedMs: 2.5 })),
};
const runtime = runtimeForLogger(createSubsystemLogger("fixture/logging"));
const host = getAiTransportHost();
const context = {
  sessionKey: structured.sessionKey,
  runId: structured.runId,
  requestId: "fixture:1",
};
const cleanText =
  "Model request failed provider=openai model=fixture code=rate_limit_exceeded type=tokens";
const mask = () => "***";
for (let index = 0; index < 512; index++) {
  registerSecretValueForRedaction(`synthetic-secret-material-${index.toString().padStart(4, "0")}`);
}
assert.equal(redactRegisteredSecretValues("synthetic-secret-material-0001", mask), "***");
assert.equal(redactRegisteredSecretValues(cleanText, mask), cleanText);
const model: Model = {
  id: "fixture-model",
  name: "Synthetic logging fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://synthetic.invalid/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 100_000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const responseBody = JSON.stringify({
  error: { message: "Synthetic rate limit", code: "rate_limit_exceeded", type: "tokens" },
});
configureAiTransportHost({
  ...host,
  buildModelFetch: () => async () => {
    requests++;
    return new Response(responseBody, {
      status: 429,
      headers: { "content-type": "application/json", "x-request-id": "req_synthetic" },
    });
  },
});
const stream = createOpenAIResponsesTransportStreamFn();
const request = {
  messages: [{ role: "user" as const, content: "Synthetic request", timestamp: 0 }],
  tools: details.map((name, index) => ({
    name: `fixture_tool_${index}`,
    description: name,
    parameters: Type.Object({ query: Type.String() }),
  })),
};
const report = { info: () => reports++ };
function runSync(count: number) {
  for (let index = 0; index < count; index++) {
    switch (scenario) {
      case "chat-send": {
        const diagnostic = startChatSendDiagnostics(report);
        const authority = diagnostic.scope("authority");
        for (const name of details) {
          diagnostic.observeSpan(name, undefined, 2.5);
        }
        authority?.finish();
        diagnostic.acknowledge();
        diagnostic.observeSpan("workspace", undefined, 1);
        diagnostic.finish();
        break;
      }
      case "disabled-runtime":
        runtime.log("ready", structured);
        runtime.error("retry", structured);
        runtime.writeJson(structured);
        break;
      case "disabled-context":
        withModelTransportContext(context, () => {
          host.logInfo("fixture/logging", "ready");
          host.logWarn("fixture/logging", "retry");
        });
        break;
      case "registry-miss":
        assert.equal(redactRegisteredSecretValues(cleanText, mask), cleanText);
        break;
    }
  }
}
async function run(count: number) {
  if (scenario !== "provider-429") {
    runSync(count);
    return;
  }
  for (let index = 0; index < count; index++) {
    const result = await withModelTransportContext(context, async () => {
      const response = await stream(model, request, {
        apiKey: "synthetic-fixture",
        transport: "sse",
      });
      for await (const event of response) {
        // Drain the real transport, including terminal error delivery.
        void event;
      }
      return response.result();
    });
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorCode, "rate_limit_exceeded");
    failures++;
  }
}
const scenarios =
  values.scenario === "all"
    ? ["chat-send", "disabled-runtime", "disabled-context", "registry-miss", "provider-429"]
    : [values.scenario];
const modes = values.mode === "both" ? ["timing", "allocation"] : [values.mode];
for (scenario of scenarios) {
  setLoggerOverride({
    level: "silent",
    consoleLevel: scenario === "provider-429" ? "warn" : "silent",
    consoleStyle: "json",
  });
  for (const mode of modes) {
    await run(Math.min(iterations, scenario === "provider-429" ? 100 : 500));
    globalThis.gc();
    await nextTurn();
    logLines = logBytes = requests = failures = reports = 0;
    const inspector = new Session();
    if (mode === "allocation") {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 8192,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const hostLoad = loadavg();
    const before = process.threadCpuUsage();
    const started = performance.now();
    await run(iterations);
    const wallMs = performance.now() - started;
    const cpu = process.threadCpuUsage(before);
    const profile =
      mode === "allocation"
        ? (await inspector.post("HeapProfiler.stopSampling")).profile
        : undefined;
    inspector.disconnect();
    if (scenario === "provider-429") {
      assert.equal(requests, iterations, "SDK must not retry outside the measured attempt");
      assert.equal(failures, iterations);
      assert(logLines >= iterations, "Every failed attempt must reach the real console logger");
    } else {
      assert.equal(logLines, 0);
      assert.equal(reports, 0, "A slow send during the microbench invalidates this arm");
    }
    console.log(
      JSON.stringify({
        scenario,
        mode,
        iterations,
        wallMs,
        cpuUsPerOperation: (cpu.user + cpu.system) / iterations,
        sampledBytesPerOperation: profile
          ? profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations
          : undefined,
        requests,
        failures,
        consoleLinesPerOperation: logLines / iterations,
        consoleBytesPerOperation: logBytes / iterations,
        hostLoad,
        memory: process.memoryUsage(),
        node: process.version,
      }),
    );
  }
}
