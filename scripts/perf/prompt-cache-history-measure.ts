// Run on a benchmark host: node --import ./scripts/tsx.mjs scripts/perf/prompt-cache-history-measure.ts
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { convertToLlm } from "../../packages/agent-core/src/harness/messages.js";
import { normalizeTranscriptJsonValue } from "../../src/config/sessions/transcript-json.js";
import type { Message } from "../../src/llm/types.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    "start-at": { type: "string", default: "0" },
  },
});
// Observe actual hash inputs without a production instrumentation seam.
const originalHash = crypto.hash;
let hashes = 0;
let bytes = 0;
crypto.hash = new Proxy(originalHash, {
  apply(target, receiver, args: Parameters<typeof crypto.hash>) {
    const data = args[1];
    hashes++;
    bytes += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    return Reflect.apply(target, receiver, args);
  },
});
syncBuiltinESMExports();
const {
  fingerprintMessage,
}: typeof import("../../src/agents/embedded-agent-runner/prompt-cache-history.js") = await import(
  values.owner
    ? pathToFileURL(values.owner).href
    : "../../src/agents/embedded-agent-runner/prompt-cache-history.js"
);

function fixture(mode: "append" | "sealed" | "mutable"): Message[] {
  return Array.from({ length: 400 }, (_, index) => {
    const message: Message = {
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "fixture-model",
      content: [
        { type: "text", text: `Synthetic reasoning ${index}: ${"text ".repeat(800)}` },
        {
          type: "toolCall",
          id: `call-${index}`,
          name: "exec",
          arguments: {
            command: `printf fixture-${index}`,
            options: {
              items: Array.from({ length: 32 }, (_unused, item) => ({
                item,
                text: "x".repeat(256),
              })),
            },
          },
        },
      ],
      usage: {
        input: 10_000,
        output: 100,
        cacheRead: 9_000,
        cacheWrite: 0,
        totalTokens: 10_100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: index,
    };
    if (mode === "append") {
      normalizeTranscriptJsonValue(message, "");
    } else if (mode === "sealed") {
      normalizeTranscriptJsonValue({ message }, "");
    }
    return message;
  });
}

const fixtures = (["append", "sealed", "mutable"] as const).map((mode) => ({
  mode,
  messages: fixture(mode),
}));
const wait = Number(values["start-at"]) - Date.now();
if (wait > 0) {
  await new Promise((resolve) => {
    setTimeout(resolve, wait);
  });
}
const rows = [];
for (const { mode, messages } of fixtures) {
  let previous: ReturnType<typeof fingerprintMessage>[] = [];
  for (const [phase, calls] of [
    ["cold", 1],
    ["warm", 100],
  ] as const) {
    hashes = 0;
    bytes = 0;
    const cpu = process.cpuUsage();
    const started = performance.now();
    for (let call = 0; call < calls; call++) {
      const history = convertToLlm(messages).map((message, index) =>
        fingerprintMessage(message, previous[index]),
      );
      if (previous.length) {
        assert.ok(history.every((fingerprint, index) => fingerprint === previous[index]));
      }
      previous = history;
    }
    const elapsedMs = performance.now() - started;
    const used = process.cpuUsage(cpu);
    rows.push({
      mode,
      phase,
      calls,
      fingerprintsPerCall: messages.length,
      hashesPerCall: hashes / calls,
      bytesPerCall: bytes / calls,
      bytesPerFingerprint: bytes / calls / messages.length,
      msPerCall: elapsedMs / calls,
      cpuMsPerCall: (used.user + used.system) / 1000 / calls,
      fingerprintDigest: originalHash("sha256", JSON.stringify(previous), "hex"),
    });
  }
}
console.log(JSON.stringify({ node: process.version, rows }));
