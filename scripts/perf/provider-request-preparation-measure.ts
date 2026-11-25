/**
 * Compare provider request preparation against a Git revision using the real owners.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/provider-request-preparation-measure.ts \
 *   --base <commit> --iterations 2000 --pairs 5 --output .local/provider-preparation.json
 *
 * Uses synthetic 40-tool / 12-message requests and an in-process terminal stream,
 * never a provider or Gateway. Five counterbalanced pairs measure untraced CPU;
 * separate inspector passes sample allocations, including collected objects.
 * Baseline owner modules temporarily live beside their originals so unchanged
 * relative imports use the same dependencies. Only these three owner files vary.
 * A/A control: pass --candidate <same commit as --base>. No Gateway-scale claim.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type ProviderStreamOptions,
} from "openclaw/plugin-sdk/llm";
import { createEmptyTransportUsage } from "openclaw/plugin-sdk/provider-transport-runtime";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({
  options: {
    base: { type: "string" },
    candidate: { type: "string" },
    iterations: { type: "string", default: "2000" },
    pairs: { type: "string", default: "5" },
    output: { type: "string" },
  },
});
assert(values.base && values.output, "--base and --output are required");
assert(global.gc, "run with --expose-gc");
const iterations = Number(values.iterations);
const pairs = Number(values.pairs);
assert(Number.isSafeInteger(iterations) && iterations > 0, "--iterations must be positive");
assert(Number.isSafeInteger(pairs) && pairs > 0, "--pairs must be positive");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const base = git("rev-parse", "--verify", `${values.base}^{commit}`).trim();
const candidate = values.candidate
  ? git("rev-parse", "--verify", `${values.candidate}^{commit}`).trim()
  : undefined;
const files = {
  anthropic: "extensions/anthropic/stream-wrappers.ts",
  google: "extensions/google/transport-stream.ts",
  ollama: "extensions/ollama/src/tool-name-aliases.ts",
};
const temporaryFiles: string[] = [];
const sources: Record<string, string> = {};

async function ownerUrl(file: string, revision: string | undefined): Promise<string> {
  const source = revision
    ? git("show", `${revision}:${file}`)
    : await readFile(path.join(root, file), "utf8");
  sources[`${revision ?? "working-tree"}:${file}`] = createHash("sha256")
    .update(source)
    .digest("hex");
  if (!revision) {
    return pathToFileURL(path.join(root, file)).href;
  }
  const temporary = path.join(
    path.dirname(path.join(root, file)),
    `.provider-preparation-${randomUUID()}.ts`,
  );
  await writeFile(temporary, source, { flag: "wx" });
  temporaryFiles.push(temporary);
  return pathToFileURL(temporary).href;
}

const model: Model<"google-generative-ai"> = {
  id: "gemini-2.5-pro",
  name: "Synthetic provider request",
  api: "google-generative-ai",
  provider: "google",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  reasoning: true,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const anthropicModel: Model = {
  ...model,
  id: "claude-sonnet-4-6",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
};
const ollamaModel: Model = {
  ...model,
  id: "qwen3:8b",
  provider: "ollama",
  api: "ollama",
  baseUrl: "http://127.0.0.1:40000",
};
const completed: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Complete" }],
  api: "ollama",
  provider: "ollama",
  model: "synthetic",
  stopReason: "stop",
  usage: createEmptyTransportUsage(),
  timestamp: 0,
};
const context: Context = {
  systemPrompt: "Synthetic benchmark. Inspect data using the supplied tools.",
  tools: Array.from({ length: 40 }, (_, index) => ({
    name: index === 0 ? "ls" : `fixture_tool_${index}`,
    description: `Read synthetic fixture ${index}`,
    parameters: { type: "object", properties: { query: { type: "string" } } },
  })),
  messages: Array.from({ length: 4 }, (_, index): Context["messages"] => [
    { role: "user", content: `Inspect synthetic fixture ${index}`, timestamp: index },
    {
      ...completed,
      content: [
        { type: "toolCall", id: `call_${index}`, name: "ls", arguments: { query: "fixture" } },
      ],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: `call_${index}`,
      toolName: "ls",
      content: [{ type: "text", text: "Synthetic result ".repeat(40) }],
      isError: false,
      timestamp: index,
    },
  ]).flat(),
};
const options: ProviderStreamOptions = {
  apiKey: "synthetic-benchmark-key",
  maxTokens: 4096,
  temperature: 0.4,
  stop: ["Synthetic stop"],
  cacheRetention: "short",
  sessionId: "synthetic-benchmark-session",
  headers: { "anthropic-beta": "fixture-beta,fine-grained-tool-streaming-2025-05-14" },
  toolChoice: { type: "function", function: { name: "ls" } },
};
let sink: unknown;
type Workload = { name: keyof typeof files; run: () => void };

async function workloads(revision: string | undefined): Promise<Workload[]> {
  const anthropic: typeof import("../../extensions/anthropic/stream-wrappers.js") = await import(
    await ownerUrl(files.anthropic, revision)
  );
  const google: typeof import("../../extensions/google/transport-stream.js") = await import(
    await ownerUrl(files.google, revision)
  );
  const ollama: typeof import("../../extensions/ollama/src/tool-name-aliases.js") = await import(
    await ownerUrl(files.ollama, revision)
  );
  const terminal = createAssistantMessageEventStream();
  terminal.end(completed);
  const betaWrapper = anthropic.createAnthropicBetaHeadersWrapper(
    (_model, _context, request) => {
      sink = request;
      return terminal;
    },
    ["fixture-beta", "fixture-beta", "interleaved-thinking-2025-05-14"],
  );
  const underlying: StreamFn = (_model, _context, request) => {
    sink = request;
    const stream = createAssistantMessageEventStream();
    stream.end(completed);
    return stream;
  };
  const ollamaWrapper = ollama.wrapOllamaToolNames(underlying);
  return [
    {
      name: "anthropic",
      run: () => {
        void betaWrapper(anthropicModel, context, options);
      },
    },
    {
      name: "google",
      run: () => {
        sink = google.buildGoogleGenerativeAiParams(model, context, options);
      },
    },
    {
      name: "ollama",
      run: () => {
        sink = ollamaWrapper(ollamaModel, context, options);
      },
    },
  ];
}

function run(workload: Workload, count: number): void {
  for (let index = 0; index < count; index++) {
    workload.run();
  }
}

async function measure(workload: Workload, allocation: boolean) {
  run(workload, Math.min(iterations, 500));
  global.gc!();
  const inspector = allocation ? new Session() : undefined;
  try {
    if (inspector) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const hostLoad = loadavg();
    const started = performance.now();
    const cpuStart = process.threadCpuUsage();
    run(workload, iterations);
    const cpu = process.threadCpuUsage(cpuStart);
    const elapsedMs = performance.now() - started;
    const memoryAfter = process.memoryUsage();
    const profile = inspector
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
    return {
      mode: allocation ? "allocation" : "timing",
      iterations,
      elapsedMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      cpuUsPerOperation: (cpu.user + cpu.system) / iterations,
      sampledBytesPerOperation: profile
        ? profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations
        : undefined,
      hostLoad,
      memoryAfter,
    };
  } finally {
    inspector?.disconnect();
  }
}

try {
  const baseWorkloads = await workloads(base);
  const candidateWorkloads = await workloads(candidate);
  const results = [];
  for (const allocation of [false, true]) {
    for (let pair = 0; pair < pairs; pair++) {
      const order =
        pair % 2 === 0 ? (["base", "candidate"] as const) : (["candidate", "base"] as const);
      for (const side of order) {
        for (const workload of side === "base" ? baseWorkloads : candidateWorkloads) {
          results.push({
            pair: pair + 1,
            side,
            owner: workload.name,
            ...(await measure(workload, allocation)),
          });
        }
      }
    }
  }
  assert(sink !== undefined, "workload must produce a request or stream");
  const output = path.resolve(values.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        base,
        candidate: candidate ?? { head: git("rev-parse", "HEAD").trim(), workingTree: true },
        sources,
        node: process.version,
        fixture: { tools: context.tools!.length, messages: context.messages.length },
        results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(output);
} finally {
  await Promise.all(temporaryFiles.map((file) => unlink(file)));
}
