import { loadavg } from "node:os";
/** Reproduce inbound metadata projection cost through the shipping visible stream. */
import { performance } from "node:perf_hooks";
import { createAssistantVisibleStreamText } from "../src/agents/embedded-agent-utils.js";

const prefixes: Record<string, string> = {
  plain: "",
  "markdown-link": "[docs](https://example.com) ",
  "context-inline": "Context: ",
};
const label = process.argv[2] ?? "markdown-link";
const prefix = prefixes[label];
const kib = Number(process.argv[3] ?? 256);
if (prefix === undefined || !Number.isSafeInteger(kib) || kib <= 0) {
  throw new Error(
    "Usage: bench-inbound-metadata-stream.mts plain|markdown-link|context-inline [KiB]",
  );
}
const size = kib * 1024;
const sentence =
  "The quick brown fox jumps over the lazy dog while the operator reads the next line. ";
const source =
  prefix + sentence.repeat(Math.ceil(size / sentence.length)).slice(prefix.length, size);
const stream = createAssistantVisibleStreamText();
const cpu = process.cpuUsage();
const start = performance.now();
for (let offset = 0; offset < source.length; offset += 4) {
  stream.append(source.slice(offset, offset + 4));
}
const ms = performance.now() - start;
const usage = process.cpuUsage(cpu);
if (stream.text !== source.trim()) {
  throw new Error("Visible text changed during the marker-free benchmark.");
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
