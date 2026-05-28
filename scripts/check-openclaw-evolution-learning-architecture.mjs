#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = "extensions/evolution-learning";

const REQUIRED_MANIFEST_CONFIG_KEYS = [
  "enabled",
  "maxContextTokens",
  "confidenceThreshold",
  "remCycleHours",
  "maturityThreshold",
];

const SOURCE_TOKEN_CHECKS = [
  {
    id: "plugin-sdk-entry",
    label: "Plugin SDK entrypoint",
    tokens: ['from "openclaw/plugin-sdk/plugin-entry"', "definePluginEntry({", "id: PLUGIN_ID"],
  },
  {
    id: "operational-learning-layer",
    label: "Layer 1 operational learning",
    tokens: ['"before_prompt_build"', "capturedActivations", "recordPatternUsage"],
  },
  {
    id: "neural-router-layer",
    label: "Layer 2 neural routing",
    tokens: ['"before_model_resolve"', "classifyTask", "soft-links.json"],
  },
  {
    id: "growth-pulse-layer",
    label: "Layer 3 growth pulse",
    tokens: ["registerService", "runRemCycle", "growth-metrics.json"],
  },
  {
    id: "organic-cells-layer",
    label: "Layer 4 organic cells",
    tokens: ["cell-registry.json", "stemCells", "autoHatchAgent"],
  },
  {
    id: "hermes-learning-bridge",
    label: "Hermes learning bridge",
    tokens: ["hermes-learning-state.json", "syncHermesToEvolution", "causal-chain.jsonl"],
  },
  {
    id: "operator-surfaces",
    label: "Operator-visible command and tool surfaces",
    tokens: ["evolution_insights", "registerTool", "registerCli", "registerCommand"],
  },
];

const DOCUMENT_TOKEN_CHECKS = [
  {
    id: "architecture-blueprint",
    path: "docs/architecture/adr-evolution-learning-expansion.md",
    label: "Evolution learning architecture ADR",
    tokens: ["Operational Learning", "NEURAL ROUTER", "GROWTH PULSE", "ORGANIC CELLS"],
  },
  {
    id: "zh-architecture-blueprint",
    path: "docs/architecture/adr-\u9032\u5316\u5b78\u7fd2\u64f4\u5f35\u67b6\u69cb.md",
    label: "Traditional Chinese evolution architecture ADR",
    tokens: [
      "\u904b\u884c\u5373\u5b78\u7fd2",
      "\u795e\u7d93\u8def\u7531",
      "\u589e\u9577\u5fc3\u8df3",
      "\u6709\u6a5f\u7d30\u80de",
    ],
  },
];

function toRepoPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function pass(id, label, kind, message, resolvedPath = null) {
  return { id, label, kind, status: "pass", message, resolvedPath };
}

function fail(id, label, kind, message, resolvedPath = null) {
  return { id, label, kind, status: "fail", message, resolvedPath };
}

async function readText(filePath) {
  return (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
}

async function readJson(filePath) {
  return JSON.parse(await readText(filePath));
}

async function checkFileExists(repoRoot, relativePath, label) {
  const absolutePath = path.join(repoRoot, relativePath);
  try {
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      return fail(relativePath, label, "file", "Path exists but is not a file", relativePath);
    }
    return pass(relativePath, label, "file", "Found", relativePath);
  } catch {
    return fail(relativePath, label, "file", "Missing required file", relativePath);
  }
}

function summarizeChecks(checks) {
  const total = checks.length;
  const passed = checks.filter((entry) => entry.status === "pass").length;
  const failed = total - passed;
  return {
    total,
    passed,
    failed,
    ok: failed === 0,
  };
}

function formatReport(report) {
  const lines = [
    "OpenClaw evolution learning architecture",
    `Repo: ${report.repoRoot}`,
    `Summary: ${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed`,
  ];
  for (const check of report.checks) {
    const mark = check.status === "pass" ? "[PASS]" : "[FAIL]";
    lines.push(`${mark} ${check.kind}:${check.id} - ${check.message}`);
  }
  return lines.join("\n");
}

function checkManifest(manifest) {
  const checks = [];
  checks.push(
    manifest.id === "evolution-learning"
      ? pass("manifest-id", "Manifest id", "manifest", "id=evolution-learning")
      : fail("manifest-id", "Manifest id", "manifest", "Manifest id must be evolution-learning"),
  );
  checks.push(
    manifest.activation?.onStartup === true
      ? pass("manifest-activation", "Manifest activation", "manifest", "onStartup=true")
      : fail(
          "manifest-activation",
          "Manifest activation",
          "manifest",
          "activation.onStartup must be true",
        ),
  );
  checks.push(
    Array.isArray(manifest.contracts?.tools) &&
      manifest.contracts.tools.includes("evolution_insights")
      ? pass(
          "manifest-tool-contract",
          "Tool contract",
          "manifest",
          "contracts.tools includes evolution_insights",
        )
      : fail(
          "manifest-tool-contract",
          "Tool contract",
          "manifest",
          "contracts.tools must include evolution_insights",
        ),
  );
  for (const key of REQUIRED_MANIFEST_CONFIG_KEYS) {
    checks.push(
      manifest.configSchema?.properties?.[key]
        ? pass(
            `manifest-config-${key}`,
            `Config key ${key}`,
            "manifest",
            `configSchema.properties.${key} exists`,
          )
        : fail(
            `manifest-config-${key}`,
            `Config key ${key}`,
            "manifest",
            `Missing configSchema.properties.${key}`,
          ),
    );
  }
  return checks;
}

function checkPackageManifest(pluginPackage) {
  const checks = [];
  checks.push(
    pluginPackage.name === "@openclaw/evolution-learning"
      ? pass("package-name", "Plugin package name", "package", "name=@openclaw/evolution-learning")
      : fail(
          "package-name",
          "Plugin package name",
          "package",
          "Package name must be @openclaw/evolution-learning",
        ),
  );
  checks.push(
    pluginPackage.openclaw?.extensions?.includes("./index.ts")
      ? pass(
          "package-openclaw-entry",
          "OpenClaw package entry",
          "package",
          "openclaw.extensions includes ./index.ts",
        )
      : fail(
          "package-openclaw-entry",
          "OpenClaw package entry",
          "package",
          "openclaw.extensions must include ./index.ts",
        ),
  );
  checks.push(
    pluginPackage.exports?.["."] === "./index.ts"
      ? pass("package-export-entry", "Package export entry", "package", "exports['.']=./index.ts")
      : fail(
          "package-export-entry",
          "Package export entry",
          "package",
          "exports['.'] must be ./index.ts",
        ),
  );
  return checks;
}

function checkRootPackage(rootPackage) {
  const script = rootPackage.scripts?.["check:openclaw-evolution-learning-architecture"];
  return [
    typeof script === "string" &&
    script.includes("scripts/check-openclaw-evolution-learning-architecture.mjs")
      ? pass(
          "root-package-script",
          "Root package script",
          "package",
          "check:openclaw-evolution-learning-architecture is wired",
        )
      : fail(
          "root-package-script",
          "Root package script",
          "package",
          "Missing check:openclaw-evolution-learning-architecture script",
        ),
  ];
}

function checkTokens(content, check, kind = "source", resolvedPath = null) {
  const missing = check.tokens.filter((token) => !content.includes(token));
  return missing.length === 0
    ? pass(check.id, check.label, kind, "All required tokens found", resolvedPath)
    : fail(check.id, check.label, kind, `Missing tokens: ${missing.join(", ")}`, resolvedPath);
}

export async function buildEvolutionLearningArchitectureReport(repoRoot = process.cwd()) {
  const normalizedRoot = path.resolve(repoRoot);
  const pluginRoot = path.join(normalizedRoot, PLUGIN_ROOT);
  const checks = [];

  checks.push(
    await checkFileExists(normalizedRoot, `${PLUGIN_ROOT}/openclaw.plugin.json`, "Plugin manifest"),
  );
  checks.push(
    await checkFileExists(normalizedRoot, `${PLUGIN_ROOT}/package.json`, "Plugin package"),
  );
  checks.push(
    await checkFileExists(normalizedRoot, `${PLUGIN_ROOT}/index.ts`, "Plugin entrypoint"),
  );

  try {
    checks.push(...checkManifest(await readJson(path.join(pluginRoot, "openclaw.plugin.json"))));
  } catch (error) {
    checks.push(
      fail(
        "manifest-parse",
        "Manifest parse",
        "manifest",
        `Manifest read failed: ${error instanceof Error ? error.message : String(error)}`,
        `${PLUGIN_ROOT}/openclaw.plugin.json`,
      ),
    );
  }

  try {
    checks.push(...checkPackageManifest(await readJson(path.join(pluginRoot, "package.json"))));
  } catch (error) {
    checks.push(
      fail(
        "package-parse",
        "Plugin package parse",
        "package",
        `Package read failed: ${error instanceof Error ? error.message : String(error)}`,
        `${PLUGIN_ROOT}/package.json`,
      ),
    );
  }

  try {
    checks.push(...checkRootPackage(await readJson(path.join(normalizedRoot, "package.json"))));
  } catch (error) {
    checks.push(
      fail(
        "root-package-parse",
        "Root package parse",
        "package",
        `Root package read failed: ${error instanceof Error ? error.message : String(error)}`,
        "package.json",
      ),
    );
  }

  try {
    const source = await readText(path.join(pluginRoot, "index.ts"));
    for (const check of SOURCE_TOKEN_CHECKS) {
      checks.push(checkTokens(source, check, "source", `${PLUGIN_ROOT}/index.ts`));
    }
  } catch (error) {
    checks.push(
      fail(
        "source-read",
        "Plugin source read",
        "source",
        `Source read failed: ${error instanceof Error ? error.message : String(error)}`,
        `${PLUGIN_ROOT}/index.ts`,
      ),
    );
  }

  for (const docCheck of DOCUMENT_TOKEN_CHECKS) {
    checks.push(await checkFileExists(normalizedRoot, docCheck.path, docCheck.label));
    try {
      checks.push(
        checkTokens(
          await readText(path.join(normalizedRoot, docCheck.path)),
          docCheck,
          "doc",
          docCheck.path,
        ),
      );
    } catch (error) {
      checks.push(
        fail(
          `${docCheck.id}-read`,
          `${docCheck.label} read`,
          "doc",
          `Doc read failed: ${error instanceof Error ? error.message : String(error)}`,
          docCheck.path,
        ),
      );
    }
  }

  return {
    schema: "openclaw.evolution-learning.architecture-check.v1",
    repoRoot: toRepoPath(normalizedRoot),
    generatedAt: new Date().toISOString(),
    checks,
    summary: summarizeChecks(checks),
    status: summarizeChecks(checks).ok ? "passed" : "failed",
    safety: {
      readOnly: true,
      runtimeLoaded: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
    },
    nextSafeTask: summarizeChecks(checks).ok
      ? "Run pnpm autonomous:inventory:check to confirm the new gate is discoverable."
      : "Fix the failed evolution-learning architecture check before splitting or promoting the module.",
  };
}

export async function runEvolutionLearningArchitectureCheck({
  argv = process.argv.slice(2),
  io = { stdout: process.stdout, stderr: process.stderr },
  repoRoot = process.cwd(),
} = {}) {
  const jsonMode = argv.includes("--json");
  const report = await buildEvolutionLearningArchitectureReport(repoRoot);
  io.stdout.write(jsonMode ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);

  if (report.summary.ok) {
    io.stdout.write("OPENCLAW_EVOLUTION_LEARNING_ARCHITECTURE_CHECK=OK\n");
    return 0;
  }

  io.stderr.write("openclaw evolution-learning architecture check failed\n");
  for (const check of report.checks) {
    if (check.status === "fail") {
      io.stderr.write(`- ${check.kind}:${check.id} - ${check.message}\n`);
    }
  }
  return 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentPath = fileURLToPath(import.meta.url);
if (invokedPath === currentPath) {
  runEvolutionLearningArchitectureCheck()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(
        `openclaw evolution-learning architecture check crashed: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }\n`,
      );
      process.exitCode = 1;
    });
}
