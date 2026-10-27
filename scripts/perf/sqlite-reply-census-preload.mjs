// Diagnostic only: the benchmark driver supplies generated synthetic state.
// team-shape-stress.ts --gateway-preload scripts/perf/sqlite-reply-census-preload.mjs
// writes sqlite-census.sqlite-replies.json and bounded sample replies in the run output.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { deserialize } from "node:v8";
import { isMainThread, Worker } from "node:worker_threads";

if (isMainThread) {
  // Capture before the profile preload replaces the live ESM deserialize binding.
  const decodeCommand = deserialize;
  const requests = new WeakMap();
  const captures = new Map();
  const maximumGroups = 256;
  const maximumSampleBytes = 8 * 1024 * 1024;
  const maximumCaptureBytes = 32 * 1024 * 1024;
  const scope =
    "Synthetic SQLite worker replies received within the profile window; counts and samples are diagnostic, not timing evidence. Admission messages are excluded.";

  process.on("message", (incoming) => {
    const message =
      incoming?.channel === "team-shape-stress"
        ? {
            ...incoming,
            channel: "openclaw-gateway-bench-profile",
            kind: "stress",
            profilePath: path.join(incoming.output, "sqlite-census"),
          }
        : incoming;
    if (
      message?.channel !== "openclaw-gateway-bench-profile" ||
      !["cpu", "heap", "stress"].includes(message.kind)
    ) {
      return;
    }
    if (message.action === "start") {
      captures.set(message.kind, {
        startedAt: performance.now(),
        path: message.profilePath,
        groups: new Map(),
        samples: new Set(),
        sampleBytes: 0,
      });
    } else if (message.action === "stop") {
      const capture = captures.get(message.kind);
      if (capture) {
        captures.delete(message.kind);
        writeFileSync(
          `${capture.path}.sqlite-replies.json`,
          JSON.stringify(
            {
              scope,
              durationMs: performance.now() - capture.startedAt,
              sampleBytes: capture.sampleBytes,
              groups: Object.fromEntries(capture.groups),
            },
            null,
            2,
          ),
        );
      }
    }
  });

  const post = Worker.prototype.postMessage;
  const emit = Worker.prototype.emit;
  Worker.prototype.postMessage = function (message, ...args) {
    if (typeof message?.actor === "number" && typeof message.id === "number") {
      // The SQLite broker owns one in-flight request per worker, including frames.
      if (requests.get(this)?.id !== message.id) {
        let label = message.type;
        if (message.type === "execute" && message.input instanceof Uint8Array) {
          try {
            const command = decodeCommand(message.input);
            const inner = command?.input?.command;
            label = inner ? `${command.type}.${inner.type}` : (command?.type ?? label);
            if (typeof command?.input?.kind === "string") {
              label += `.${command.input.kind}`;
            }
          } catch {
            label = "unclassified";
          }
        }
        requests.set(this, {
          id: message.id,
          label:
            typeof label === "string" && /^[a-zA-Z0-9._-]{1,96}$/.test(label)
              ? label
              : "unclassified",
        });
      }
    }
    return post.call(this, message, ...args);
  };
  Worker.prototype.emit = function (event, message, ...args) {
    if (event === "message" && typeof message?.ok === "boolean") {
      const pending = requests.get(this);
      const method = pending && pending.id === message.id ? pending.label : undefined;
      if (method) {
        for (const capture of captures.values()) {
          const label =
            capture.groups.has(method) || capture.groups.size < maximumGroups ? method : "other";
          let metric = capture.groups.get(label);
          if (!metric) {
            metric = { count: 0, bytes: 0, maxBytes: 0, framed: 0, failed: 0 };
            capture.groups.set(label, metric);
          }
          const bytes = message.value instanceof Uint8Array ? message.value.byteLength : 0;
          metric.count++;
          metric.bytes += bytes;
          metric.maxBytes = Math.max(metric.maxBytes, bytes);
          metric.framed += message.transfer ? 1 : 0;
          metric.failed += message.ok ? 0 : 1;
          if (
            message.ok &&
            bytes > 0 &&
            !message.transfer &&
            !message.input &&
            !capture.samples.has(label) &&
            bytes <= maximumSampleBytes &&
            capture.sampleBytes + bytes <= maximumCaptureBytes
          ) {
            const sample = `${capture.path}.reply-${label}.bin`;
            writeFileSync(sample, message.value);
            capture.samples.add(label);
            capture.sampleBytes += bytes;
            metric.sample = sample;
          }
        }
        if (!message.transfer && !message.input) {
          requests.delete(this);
        }
      }
    }
    return emit.call(this, event, message, ...args);
  };
}
