#!/usr/bin/env node
import {
  SNES_BENCHMARK_ROLES,
  createSnesLocalModelBenchmarkReport,
  createSnesOutputBenchmarkReport,
  discoverAgentDefaultModel,
  discoverLocalLlamaCppGlmModels,
  discoverOllamaModels,
  probeLocalLlamaCppGlmRuntime,
  writeBenchmarkArtifacts,
} from "./lib/snes-local-model-benchmark.mjs";
import { existsSync } from "node:fs";

function parseArgs(argv) {
  const args = {
    artifactDir: ".artifacts/snes-local-model-benchmark",
    json: false,
    judge: "none",
    maxOutputTokens: 260,
    mode: "synthetic",
    models: null,
    noDownload: true,
    rounds: 1,
    roles: null,
    timeoutSeconds: 180,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-dir") {
      args.artifactDir = argv[++index] ?? args.artifactDir;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--judge") {
      args.judge = argv[++index] ?? args.judge;
    } else if (arg === "--max-output-tokens") {
      args.maxOutputTokens = Number(argv[++index] ?? args.maxOutputTokens);
    } else if (arg === "--mode") {
      args.mode = argv[++index] ?? args.mode;
    } else if (arg === "--models") {
      args.models = String(argv[++index] ?? "")
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean);
    } else if (arg === "--no-download") {
      args.noDownload = true;
    } else if (arg === "--rounds") {
      args.rounds = Number(argv[++index] ?? args.rounds);
    } else if (arg === "--roles") {
      args.roles = String(argv[++index] ?? "")
        .split(",")
        .map((role) => role.trim())
        .filter(Boolean);
    } else if (arg === "--timeout") {
      args.timeoutSeconds = Number(argv[++index] ?? args.timeoutSeconds);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }
  if (args.mode === "output" && args.artifactDir === ".artifacts/snes-local-model-benchmark") {
    args.artifactDir = ".artifacts/snes-real-output-model-benchmark";
  }
  return args;
}

function printHelp() {
  console.log(
    [
      "Usage: pnpm snes:benchmark:models -- --no-download [--timeout <seconds>] [--json]",
      "       pnpm snes:benchmark:models -- --mode output --models ollama/openclaw-control-qwen25-32b:latest,local-glm-5.2-2bit --judge none --no-download --timeout 300 --json",
      "",
      "Synthetic mode preserves the fast local availability ladder.",
      "Output mode asks installed local models to produce SNES Studio role JSON, saves raw outputs, and scores them.",
      "Use --models with comma-separated model refs for a bounded side-by-side run.",
      "Use --roles with comma-separated role ids for a quick single-role side-by-side run.",
      "Use --max-output-tokens to bound local generation cost/time; default is 260.",
      "Use --rounds to repeat output benchmarks and aggregate winners; default is 1.",
      "Output mode never downloads models and never uses hosted GLM.",
      "GPT 5.5 judge mode requires OPENCLAW_SNES_BENCHMARK_GPT_JUDGE=1.",
    ].join("\n"),
  );
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

if (args.mode !== "synthetic" && args.mode !== "output") {
  throw new Error(`Unsupported benchmark mode: ${args.mode}`);
}
if (args.judge !== "none" && args.judge !== "gpt-5.5") {
  throw new Error(`Unsupported benchmark judge: ${args.judge}`);
}

const localGlmDiagnostic = probeLocalLlamaCppGlmRuntime(undefined, {
  baseUrl: process.env.OPENCLAW_LOCAL_GLM52_BASE_URL,
  maxOutputTokens: Math.min(32, args.maxOutputTokens),
  timeoutSeconds: Math.min(30, args.timeoutSeconds),
});
const localGlmModelPath =
  process.env.OPENCLAW_LOCAL_GLM52_MODEL_PATH ??
  `${process.env.HOME ?? "."}/.cache/openclaw-models/glm-5.2/UD-IQ1_S/GLM-5.2-UD-IQ1_S-00001-of-00006.gguf`;
localGlmDiagnostic.modelFilesPresent = existsSync(localGlmModelPath);
localGlmDiagnostic.modelPath = localGlmModelPath;
const installedModelRefs = [
  ...discoverOllamaModels(),
  ...(localGlmDiagnostic.decodeReady ? ["local-glm-5.2-2bit"] : []),
];
const defaultModelsByRole = Object.fromEntries(
  SNES_BENCHMARK_ROLES.map((role) => [
    role,
    discoverAgentDefaultModel(role) ?? "ollama/openclaw-control-qwen25-32b:latest",
  ]),
);
const report =
  args.mode === "output"
    ? createSnesOutputBenchmarkReport({
        defaultModelsByRole,
        installedModelRefs,
        candidateModelRefs: args.models,
        judge: args.judge,
        localModelDiagnostics: { "local-glm-5.2-2bit": localGlmDiagnostic },
        maxOutputTokens: args.maxOutputTokens,
        noDownload: args.noDownload,
        rounds: args.rounds,
        roles: args.roles,
        timeoutSeconds: args.timeoutSeconds,
      })
    : createSnesLocalModelBenchmarkReport({
        defaultModelsByRole,
        installedModelRefs,
        noDownload: args.noDownload,
        roles: args.roles,
        timeoutSeconds: args.timeoutSeconds,
      });
const artifacts = writeBenchmarkArtifacts(report, args.artifactDir);

if (args.json) {
  console.log(JSON.stringify({ ...report, artifacts }, null, 2));
} else {
  console.log(`SNES ${args.mode} model benchmark: ${report.status}`);
  console.log(`Wrote ${artifacts.latestPath}`);
  console.log(`Downloads attempted: ${report.downloadsAttempted ? "yes" : "no"}`);
  console.log(`Hosted providers used: ${report.hostedProvidersUsed ? "yes" : "no"}`);
  if ("hostedGlmUsed" in report) {
    console.log(`Hosted GLM used: ${report.hostedGlmUsed ? "yes" : "no"}`);
  }
  if (report.localModelDiagnostics?.["local-glm-5.2-2bit"]) {
    const diagnostic = report.localModelDiagnostics["local-glm-5.2-2bit"];
    console.log(
      `Local GLM decode: ${diagnostic.decodeReady ? "ready" : "blocked"}${diagnostic.blocker ? ` (${diagnostic.blocker})` : ""}`,
    );
  }
  for (const role of report.roles) {
    console.log(`- ${role}: ${report.winnersByRole[role]}`);
  }
}
