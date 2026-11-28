import { loadavg } from "node:os";
/** Reproduce inbound metadata projection cost through the shipping visible stream. */
import { performance } from "node:perf_hooks";
import { createAssistantVisibleStreamText } from "../src/agents/embedded-agent-utils.js";

const prefixes: Record<string, string> = {
  plain: "",
  "markdown-link": "[docs](https://example.com) ",
  "context-inline": "Context: ",
  "authenticated-metadata":
    'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"id":"synthetic"}\n```\n\n',
};
const label = process.argv[2] ?? "markdown-link";
const prefix = prefixes[label];
const kib = Number(process.argv[3] ?? 256);
if (prefix === undefined || !Number.isSafeInteger(kib) || kib <= 0) {
  throw new Error(
    "Usage: bench-inbound-metadata-stream.mts plain|markdown-link|context-inline|authenticated-metadata [KiB]",
  );
}
const size = kib * 1024;
const sentence =
  "The quick brown fox jumps over the lazy dog while the operator reads the next line. ";
const bodyLength = Math.max(0, size - prefix.length);
const body = sentence.repeat(Math.ceil(bodyLength / sentence.length)).slice(0, bodyLength);
const source = prefix + body;
const stream = createAssistantVisibleStreamText();
const cpu = process.cpuUsage();
const start = performance.now();
for (let offset = 0; offset < source.length; offset += 4) {
  stream.append(source.slice(offset, offset + 4));
}
const ms = performance.now() - start;
const usage = process.cpuUsage(cpu);
const expected = label === "authenticated-metadata" ? body.trim() : source.trim();
if (stream.text !== expected) {
  throw new Error("Visible text changed during the benchmark.");
}
console.log(
  JSON.stringify({
    label,
    kib,
    delta: 4,
    ms,
    cpuMs: (usage.user + usage.system) / 1000,
    load: loadavg(),
    node: process.version,
  }),
);
