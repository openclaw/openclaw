#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_GRAPH_PATH = "reports/openclaw-card-framework-graph.json";
const DEFAULT_OUT_PATH = "reports/openclaw-card-module-generator-dry-run-latest.json";
const DEFAULT_PROPOSAL_OUT_PATH = "reports/openclaw-card-module-proposal-latest.json";

function toRepoPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function parseFlagValue(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  if (index >= 0 && argv[index + 1]) {
    return argv[index + 1];
  }
  return fallback;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function validateGraph(graph) {
  const failures = [];
  if (graph?.kind !== "openclaw-card-framework-graph") {
    failures.push("kind must be openclaw-card-framework-graph");
  }
  if (graph?.validation?.ok !== true) {
    failures.push("graph validation must be ok");
  }
  if ((graph?.graph?.missingLinks ?? []).length > 0) {
    failures.push("graph has missing links");
  }
  if ((graph?.graph?.duplicateNodeIds ?? []).length > 0) {
    failures.push("graph has duplicate node ids");
  }
  if (!Array.isArray(graph?.graph?.nodes) || graph.graph.nodes.length === 0) {
    failures.push("graph nodes are missing");
  }
  return failures;
}

function artifactKindForNode(node) {
  const text = `${node.id ?? ""} ${node.label ?? ""}`.toLowerCase();
  if (text.includes("agent")) {
    return "agent-workspace-plan";
  }
  switch (node.openclawTarget) {
    case "skill":
      return "skill";
    case "plugin":
      return "plugin";
    case "runtime":
      return "runtime-module";
    case "taskflow":
      return "taskflow";
    case "docs":
      return "docs";
    default:
      return "unsupported";
  }
}

function plannedFilesForNode(node) {
  const slug = slugify(node.id);
  const kind = artifactKindForNode(node);
  switch (kind) {
    case "skill":
      return [`skills/${slug}/SKILL.md`, `reports/openclaw-card-module-generator/${slug}.json`];
    case "plugin":
      return [
        `extensions/${slug}/openclaw.plugin.json`,
        `extensions/${slug}/package.json`,
        `extensions/${slug}/index.ts`,
        `extensions/${slug}/src/runtime.ts`,
        `extensions/${slug}/src/${slug}.test.ts`,
      ];
    case "runtime-module":
      return [
        `scripts/${slug}.mjs`,
        `scripts/check-${slug}.mjs`,
        `test/scripts/${slug}.test.ts`,
        `reports/${slug}-latest.json`,
      ];
    case "taskflow":
      return [
        `docs/automation/${slug}.md`,
        `reports/openclaw-card-module-generator/taskflow-${slug}.json`,
      ];
    case "agent-workspace-plan":
      return [
        `reports/openclaw-card-module-generator/agent-${slug}.json`,
        `skills/${slug}-operator/SKILL.md`,
      ];
    case "docs":
      return [`docs/automation/${slug}.md`, `reports/openclaw-card-module-generator/${slug}.json`];
    default:
      return [`reports/openclaw-card-module-generator/${slug}-unsupported.json`];
  }
}

function validationCommandsForNode(node) {
  const slug = slugify(node.id);
  const kind = artifactKindForNode(node);
  const commands = ["pnpm check:openclaw-card-framework", "pnpm openclaw:card:graph:check"];
  if (kind === "skill") {
    commands.push("pnpm autonomous:inventory:check");
  } else if (kind === "plugin") {
    commands.push(`openclaw plugins inspect ${slug} --runtime --json`);
    commands.push(`pnpm test extensions/${slug}`);
  } else if (kind === "runtime-module") {
    commands.push(`node --check scripts/${slug}.mjs`);
    commands.push(`node --check scripts/check-${slug}.mjs`);
    commands.push(`pnpm test test/scripts/${slug}.test.ts`);
  } else if (kind === "taskflow") {
    commands.push("openclaw tasks flow list");
  } else if (kind === "agent-workspace-plan") {
    commands.push("pnpm autonomous:inventory:check");
  } else if (kind === "docs") {
    commands.push("git diff --check");
  }
  return [...new Set(commands)];
}

function templateKindForFile(filePath, artifactKind) {
  if (filePath.endsWith("/SKILL.md")) {
    return "skill-manifest";
  }
  if (filePath.endsWith("openclaw.plugin.json")) {
    return "plugin-manifest";
  }
  if (filePath.endsWith("package.json")) {
    return "plugin-package-manifest";
  }
  if (filePath.endsWith(".test.ts")) {
    return "validation-test";
  }
  if (filePath.endsWith(".mjs")) {
    return "runtime-script";
  }
  if (filePath.endsWith(".md")) {
    return "operator-doc";
  }
  if (filePath.endsWith(".json")) {
    return "state-report";
  }
  return artifactKind;
}

function riskLevelForNode(node) {
  const kind = artifactKindForNode(node);
  if (
    kind === "runtime-module" ||
    kind === "plugin" ||
    kind === "taskflow" ||
    kind === "agent-workspace-plan"
  ) {
    return "L1-review-before-apply";
  }
  return "L0-dry-run";
}

function isEligibleNode(node) {
  return (
    ["module", "capability", "component"].includes(node.type) ||
    artifactKindForNode(node) === "agent-workspace-plan"
  );
}

function createApplyProposal(node) {
  const kind = artifactKindForNode(node);
  const files = plannedFilesForNode(node);
  const postValidationCommands = [
    ...validationCommandsForNode(node),
    "pnpm openclaw:card:generate:check",
    "git diff --check",
  ];
  return {
    proposalId: `apply-${slugify(node.id)}`,
    mode: "staged-patch-plan",
    requiresCardId: node.id,
    dryRunOnly: true,
    preflightCommands: [
      "pwd",
      "git rev-parse --show-toplevel",
      "Test-Path package.json",
      "Test-Path pnpm-workspace.yaml",
      "Test-Path pnpm-lock.yaml",
      "pnpm check:openclaw-card-framework",
      "pnpm openclaw:card:graph:check",
    ],
    patchSteps: files.map((file, index) => ({
      order: index + 1,
      file,
      action: "add",
      reason: `Create ${kind} artifact from card ${node.id}`,
      templateKind: templateKindForFile(file, kind),
    })),
    postValidationCommands: [...new Set(postValidationCommands)],
    rollbackPlan: {
      mode: "planned-files-only",
      runtimeWritesNow: 0,
      files,
      instruction:
        "If this proposal is rejected after apply, revert only the listed planned files and rerun the same validation commands.",
    },
    blockedUntil: [
      "human-review-approved",
      "card-framework-pass",
      "graph-export-check-pass",
      "same-case-rerun-pass",
    ],
    safety: {
      writesRuntimeNow: false,
      externalApiEnabled: false,
      liveTradingEnabled: false,
      requiresHumanReviewBeforeApply: riskLevelForNode(node) !== "L0-dry-run",
    },
  };
}

function createDryRunDecision(node) {
  const kind = artifactKindForNode(node);
  return {
    cardId: node.id,
    title: node.label,
    cardType: node.type,
    openclawTarget: node.openclawTarget,
    artifactKind: kind,
    dryRunOnly: true,
    wouldWriteFiles: plannedFilesForNode(node),
    wouldRunValidation: validationCommandsForNode(node),
    safety: {
      writesRuntimeNow: false,
      externalApiEnabled: false,
      liveTradingEnabled: false,
      requiresHumanReviewBeforeApply: riskLevelForNode(node) !== "L0-dry-run",
      riskLevel: riskLevelForNode(node),
    },
    sourceEvidence: stringArray(node.sourceUrls),
    linkedCards: stringArray(node.linksTo),
    linkedBy: stringArray(node.linkedBy),
    contract: node.contract ?? "",
    rollbackPath: node.rollbackPath || "dry-run only; no runtime files written",
    nextSafeTask: node.nextSafeTask || "review dry-run plan before apply",
    applyProposal: createApplyProposal(node),
  };
}

export function buildModuleDryRunPlan(
  graph,
  { cardId = null, graphPath = DEFAULT_GRAPH_PATH } = {},
) {
  const failures = validateGraph(graph);
  if (failures.length > 0) {
    return {
      ok: false,
      dryRunOnly: true,
      failures,
      decisions: [],
    };
  }

  const nodes = graph.graph.nodes.filter((node) =>
    cardId ? node.id === cardId : isEligibleNode(node),
  );
  const missingCard = cardId && nodes.length === 0;
  const decisions = nodes.map(createDryRunDecision);

  return {
    ok: !missingCard,
    dryRunOnly: true,
    sourceGraph: graphPath,
    sourceRegistry: graph.source?.registryPath ?? null,
    selectedCardId: cardId,
    summary: {
      graphValidation: graph.validation?.ok === true,
      candidates: nodes.length,
      filesPlanned: decisions.reduce(
        (total, decision) => total + decision.wouldWriteFiles.length,
        0,
      ),
      runtimeWritesNow: 0,
      externalApiEnabled: false,
      liveTradingEnabled: false,
      applyProposals: decisions.length,
      reviewRequired: decisions.filter((decision) => decision.safety.requiresHumanReviewBeforeApply)
        .length,
    },
    failures: missingCard ? [`card not found: ${cardId}`] : [],
    decisions,
  };
}

export function buildProposalOnlyPlan(
  graph,
  { cardId = null, graphPath = DEFAULT_GRAPH_PATH } = {},
) {
  if (!cardId) {
    return {
      ok: false,
      dryRunOnly: true,
      mode: "proposal-only",
      failures: ["card id is required for proposal-only mode"],
    };
  }

  const modulePlan = buildModuleDryRunPlan(graph, { cardId, graphPath });
  if (!modulePlan.ok) {
    return {
      ok: false,
      dryRunOnly: true,
      mode: "proposal-only",
      failures: [...modulePlan.failures],
    };
  }

  const decision = modulePlan.decisions[0];
  if (!decision?.applyProposal) {
    return {
      ok: false,
      dryRunOnly: true,
      mode: "proposal-only",
      failures: [`proposal missing for card: ${cardId}`],
    };
  }

  return {
    ok: true,
    dryRunOnly: true,
    mode: "proposal-only",
    sourceGraph: modulePlan.sourceGraph,
    sourceRegistry: modulePlan.sourceRegistry,
    selectedCardId: cardId,
    summary: {
      runtimeWritesNow: 0,
      externalApiEnabled: false,
      liveTradingEnabled: false,
      proposalSteps: decision.applyProposal.patchSteps.length,
    },
    failures: [],
    proposal: decision.applyProposal,
  };
}

export async function runCardModuleDryRunGenerator({
  argv = process.argv.slice(2),
  repoRoot = process.cwd(),
  io = { stdout: process.stdout, stderr: process.stderr },
} = {}) {
  const normalizedRoot = path.resolve(repoRoot);
  const graphPath = toRepoPath(parseFlagValue(argv, "--graph", DEFAULT_GRAPH_PATH));
  const proposalOnly = argv.includes("--proposal-only");
  const outPath = toRepoPath(
    parseFlagValue(argv, "--out", proposalOnly ? DEFAULT_PROPOSAL_OUT_PATH : DEFAULT_OUT_PATH),
  );
  const cardId = parseFlagValue(argv, "--card", null);
  const checkMode = argv.includes("--check");
  const graph = JSON.parse(await fs.readFile(path.join(normalizedRoot, graphPath), "utf8"));
  const plan = proposalOnly
    ? buildProposalOnlyPlan(graph, { cardId, graphPath })
    : buildModuleDryRunPlan(graph, { cardId, graphPath });
  const outputText = `${JSON.stringify(plan, null, 2)}\n`;
  const absoluteOutPath = path.join(normalizedRoot, outPath);

  if (!plan.ok) {
    io.stderr.write(`openclaw card module dry-run blocked: ${plan.failures.join("; ")}\n`);
    return 1;
  }

  if (checkMode) {
    let currentText;
    try {
      currentText = await fs.readFile(absoluteOutPath, "utf8");
    } catch {
      io.stderr.write(`openclaw card module dry-run check failed: missing ${outPath}\n`);
      return 1;
    }
    if (currentText !== outputText) {
      io.stderr.write(`openclaw card module dry-run check failed: stale ${outPath}\n`);
      return 1;
    }
    io.stdout.write(`openclaw card module dry-run check passed: ${outPath}\n`);
    return 0;
  }

  await fs.mkdir(path.dirname(absoluteOutPath), { recursive: true });
  await fs.writeFile(absoluteOutPath, outputText, "utf8");
  io.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        mode: proposalOnly ? "proposal-only" : "dry-run-plan",
        outPath,
        dryRunOnly: true,
        candidates: proposalOnly ? 1 : plan.summary.candidates,
        filesPlanned: proposalOnly ? plan.proposal.patchSteps.length : plan.summary.filesPlanned,
        runtimeWritesNow: 0,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentPath = fileURLToPath(import.meta.url);
if (invokedPath === currentPath) {
  runCardModuleDryRunGenerator()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(
        `openclaw card module dry-run crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
