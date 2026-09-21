// Run on each revision: node --import ./scripts/tsx.mjs scripts/bench-redaction-hot-paths.ts
// Synthetic redaction CPU only; excludes disk writes and SQLite commit time.
import os from "node:os";
import { performance } from "node:perf_hooks";
import {
  captureSensitiveTextRedactionSnapshot,
  createSensitiveTextRedactor,
  redactLogRecordForTransport,
  serializeRedactedFileLogRecord,
} from "../src/logging/redact.js";

const redactTranscript = createSensitiveTextRedactor(captureSensitiveTextRedactionSnapshot());
const transcriptBytes = 200 * 1024;
const fill = (line: string) =>
  line.repeat(Math.ceil(transcriptBytes / line.length)).slice(0, transcriptBytes);
const secret = `sk-${"synthetic".repeat(6)}`;
const ordinary = {
  level: "info",
  message: "request completed",
  method: "sessions.list",
  count: 50,
};
const records = {
  ordinary,
  trigger: { ...ordinary, message: "session token count updated", tokens: 123 },
  secret: { ...ordinary, message: `provider rejected ${secret}` },
};
const transcripts = {
  prose: fill("The operation completed successfully. All checks passed.\n"),
  source: fill('export function readToken(token: string) { return { token, status: "ready" }; }\n'),
  masked: fill("Authorization: Bearer ***\nAPI_KEY=***\n"),
  secret: fill(`provider rejected ${secret}\n`),
};
const cases = [
  ...Object.entries(records).flatMap(([scenario, record]) => [
    {
      name: `transport/${scenario}`,
      iterations: 200,
      scale: 1000,
      run: () => JSON.stringify(redactLogRecordForTransport(record)),
    },
    {
      name: `file/${scenario}`,
      iterations: 200,
      scale: 1000,
      run: () => serializeRedactedFileLogRecord(record),
    },
  ]),
  ...Object.entries(transcripts).map(([scenario, text]) => ({
    name: `transcript/${scenario}`,
    iterations: 2,
    scale: 1,
    run: () => redactTranscript(text),
  })),
];
const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
let checksum = 0;
const results = cases.map(({ name, iterations, scale, run }) => {
  const wall: number[] = [];
  const cpu: number[] = [];
  for (let sample = -2; sample < 7; sample++) {
    const started = performance.now();
    const usage = process.threadCpuUsage();
    for (let iteration = 0; iteration < iterations; iteration++) {
      checksum += run().length;
    }
    const used = process.threadCpuUsage(usage);
    if (sample >= 0) {
      wall.push(((performance.now() - started) * scale) / iterations);
      cpu.push(((used.user + used.system) * scale) / (1000 * iterations));
    }
  }
  return { name, medianMs: median(wall), medianCpuMs: median(cpu) };
});
console.log(
  JSON.stringify(
    { node: process.version, cpu: os.cpus()[0]?.model, transcriptBytes, checksum, results },
    null,
    2,
  ),
);
