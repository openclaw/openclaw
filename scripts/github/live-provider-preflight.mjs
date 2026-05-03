#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LIVE_PROVIDER_CREDENTIALS = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD", "ANTHROPIC_API_TOKEN"],
  fireworks: ["FIREWORKS_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  xai: ["XAI_API_KEY"],
  zai: ["ZAI_API_KEY", "Z_AI_API_KEY"],
};

const KNOWN_PROVIDERS = Object.keys(LIVE_PROVIDER_CREDENTIALS);

export function normalizeProvider(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") {
    return "zai";
  }
  if (normalized === "opencode") {
    return "opencode-go";
  }
  if (normalized === "open-router") {
    return "openrouter";
  }
  return normalized;
}

export function parseProviders(raw) {
  const normalizedAll = String(raw ?? "")
    .toLowerCase()
    .replace(/[\s,]/gu, "");
  if (!normalizedAll || normalizedAll === "all") {
    return [...KNOWN_PROVIDERS];
  }

  const providers = [];
  const seen = new Set();
  for (const entry of String(raw).split(/[\s,]+/u)) {
    if (!entry) {
      continue;
    }
    const provider = normalizeProvider(entry);
    if (!provider) {
      continue;
    }
    if (!LIVE_PROVIDER_CREDENTIALS[provider]) {
      throw new Error(
        `Unknown live model provider '${entry}'. Expected one of: ${KNOWN_PROVIDERS.join(", ")}`,
      );
    }
    if (!seen.has(provider)) {
      providers.push(provider);
      seen.add(provider);
    }
  }

  if (providers.length === 0) {
    throw new Error("No live model providers selected.");
  }

  return providers;
}

export function planLiveProviderPreflight({
  env = process.env,
  laneId = "live-models",
  profile = env.RELEASE_TEST_PROFILE || "full",
  providers = parseProviders(
    env.OPENCLAW_LIVE_PROVIDERS || env.REQUESTED_LIVE_MODEL_PROVIDERS || "",
  ),
  strict = profile === "full" || env.OPENCLAW_LIVE_STRICT_PREFLIGHT === "1",
} = {}) {
  const missingCredentials = [];
  for (const provider of providers) {
    const keys = LIVE_PROVIDER_CREDENTIALS[provider];
    if (!keys.some((key) => Boolean(env[key]))) {
      missingCredentials.push({ provider, expectedEnv: keys });
    }
  }

  const status = missingCredentials.length === 0 ? "ready" : strict ? "failed" : "skipped";
  return {
    laneId,
    profile,
    providers,
    status,
    shouldRun: status === "ready",
    strict,
    missingCredentials,
  };
}

function writeGithubOutput(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  writeFileSync(outputPath, `${lines.join("\n")}\n`, { flag: "a" });
}

function appendGithubSummary(plan, summaryFile) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  const lines = [
    "### Live provider preflight",
    "",
    `- Lane: \`${plan.laneId}\``,
    `- Profile: \`${plan.profile}\``,
    `- Providers: \`${plan.providers.join(",")}\``,
    `- Status: \`${plan.status}\``,
    `- Summary: \`${summaryFile}\``,
  ];
  for (const missing of plan.missingCredentials) {
    lines.push(
      `- Missing ${missing.provider}: expected one of \`${missing.expectedEnv.join(", ")}\``,
    );
  }
  writeFileSync(summaryPath, `${lines.join("\n")}\n`, { flag: "a" });
}

export function runLiveProviderPreflight(env = process.env) {
  const laneId = env.OPENCLAW_LIVE_LANE_ID || "live-models";
  const plan = planLiveProviderPreflight({ env, laneId });
  const summaryFile =
    env.OPENCLAW_LIVE_LANE_SUMMARY_FILE ||
    path.join(".artifacts", "live-lane-summaries", `${laneId}.json`);

  mkdirSync(path.dirname(summaryFile), { recursive: true });
  writeFileSync(summaryFile, `${JSON.stringify(plan, null, 2)}\n`);
  writeGithubOutput({
    should_run: plan.shouldRun ? "1" : "0",
    status: plan.status,
    summary_file: summaryFile,
  });
  appendGithubSummary(plan, summaryFile);

  if (plan.status === "failed") {
    throw new Error(
      `Missing required live provider credentials for ${plan.missingCredentials
        .map((missing) => missing.provider)
        .join(", ")}.`,
    );
  }
  if (!plan.shouldRun) {
    console.log(`Live provider lane ${laneId} skipped; see ${summaryFile}.`);
  }
  return plan;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  try {
    runLiveProviderPreflight();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
