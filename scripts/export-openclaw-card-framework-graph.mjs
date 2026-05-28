#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectCardFrameworkReport } from "./check-openclaw-card-framework.mjs";

const DEFAULT_REGISTRY_PATH = "reports/openclaw-card-framework-cards.json";
const DEFAULT_OUT_PATH = "reports/openclaw-card-framework-graph.json";

const TYPE_ORDER = [
  "source",
  "component",
  "capability",
  "module",
  "contract",
  "validation",
  "report",
];
const TARGET_ORDER = ["docs", "skill", "plugin", "runtime", "taskflow"];
const THREE_D_VIEWPOINT_PRIMARY_IDS = [
  "source-3d-viewpoint-node-graph-standards",
  "module-3d-viewpoint-node-model",
  "contract-3d-viewpoint-node-graph-gate",
  "component-ui-surface",
  "component-validation-gate",
  "component-report-state",
  "module-architecture-model-as-code",
  "module-world-model-simulation-gate",
  "component-trading-risk-gate",
];
const ARCHITECTURE_WORLD_MODEL_PRIMARY_IDS = [
  "source-architecture-as-code-standards",
  "module-architecture-model-as-code",
  "source-world-model-simulation-standards",
  "module-world-model-simulation-gate",
  "contract-architecture-world-model-drift-gate",
  "component-validation-gate",
  "component-report-state",
  "component-trading-risk-gate",
];

function toRepoPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function typeIndex(type) {
  const index = TYPE_ORDER.indexOf(type);
  return index >= 0 ? index : TYPE_ORDER.length;
}

function targetIndex(target) {
  const index = TARGET_ORDER.indexOf(target);
  return index >= 0 ? index : TARGET_ORDER.length;
}

function deterministicPosition(card, index) {
  return {
    x: targetIndex(card.openclawTarget) * 360,
    y: typeIndex(card.type) * 240,
    z: (index % 9) * 90,
  };
}

function collectViewpointNodeIds(primaryIds, cardById) {
  const ids = new Set(primaryIds.filter((id) => cardById.has(id)));
  for (const id of ids) {
    for (const target of stringArray(cardById.get(id)?.linksTo)) {
      if (cardById.has(target)) {
        ids.add(target);
      }
    }
  }
  return [...ids];
}

function summarizeValidation(report) {
  return {
    ok: report.summary.ok,
    cards: report.summary.cards,
    checks: {
      total: report.summary.total,
      passed: report.summary.passed,
      failed: report.summary.failed,
    },
    simulation: {
      iterations: report.summary.simulation.iterations,
      correct: report.summary.simulation.correct,
      mismatches: report.summary.simulation.mismatches,
      acceptedCorrect: report.summary.simulation.acceptedCorrect,
      blockedIncorrect: report.summary.simulation.blockedIncorrect,
      falseAccepted: report.summary.simulation.falseAccepted,
      falseBlocked: report.summary.simulation.falseBlocked,
    },
    architectureImpact: report.summary.architectureImpact,
    coverage: report.coverage,
  };
}

export function buildCardFrameworkGraph(
  cards,
  { registryPath = DEFAULT_REGISTRY_PATH, report } = {},
) {
  const normalizedCards = cards.filter(isRecord);
  const cardById = new Map(normalizedCards.map((card) => [card.id, card]));
  const incoming = new Map(normalizedCards.map((card) => [card.id, []]));
  const missingLinks = [];

  for (const card of normalizedCards) {
    for (const target of stringArray(card.linksTo)) {
      if (incoming.has(target)) {
        incoming.get(target).push(card.id);
      } else {
        missingLinks.push({ source: card.id, target });
      }
    }
  }

  const nodes = normalizedCards.map((card, index) => {
    const outgoing = stringArray(card.linksTo);
    const incomingIds = incoming.get(card.id) ?? [];
    return {
      id: card.id,
      label: card.title,
      type: card.type,
      group: card.type,
      openclawTarget: card.openclawTarget,
      componentRole: card.componentRole ?? null,
      componentPaths: stringArray(card.componentPaths),
      sourceUrls: stringArray(card.sourceUrls),
      validation: stringArray(card.validation),
      risk: stringArray(card.risk),
      contract: card.contract ?? "",
      rollbackPath: card.rollbackPath ?? "",
      nextSafeTask: card.nextSafeTask ?? "",
      humanReadableCheck: card.humanReadableCheck ?? "",
      incoming: incomingIds.length,
      outgoing: outgoing.length,
      linkedBy: incomingIds,
      linksTo: outgoing,
      position: deterministicPosition(card, index),
      forceGraph: {
        nodeVal: Math.max(3, outgoing.length + incomingIds.length),
        nodeLabel: `${card.title} (${card.type}/${card.openclawTarget})`,
      },
    };
  });

  const links = normalizedCards.flatMap((card) =>
    stringArray(card.linksTo).map((target, index) => ({
      id: `${card.id}->${target}#${index}`,
      source: card.id,
      target,
      relation: "linksTo",
      sourceType: card.type,
      targetType: cardById.get(target)?.type ?? null,
      sourceTarget: card.openclawTarget,
      targetOpenClawTarget: cardById.get(target)?.openclawTarget ?? null,
      validTarget: cardById.has(target),
    })),
  );

  return {
    schemaVersion: 1,
    kind: "openclaw-card-framework-graph",
    source: {
      registryPath,
      requiredValidation: "pnpm check:openclaw-card-framework",
    },
    validation: report ? summarizeValidation(report) : null,
    graph: {
      nodes,
      links,
      missingLinks,
      duplicateNodeIds: nodes
        .map((node) => node.id)
        .filter((id, index, ids) => ids.indexOf(id) !== index),
    },
    viewpoints: [
      {
        id: "all-cards",
        title: "All OpenClaw card nodes",
        nodeIds: nodes.map((node) => node.id),
      },
      {
        id: "architecture-world-model",
        title: "Architecture / World Model branch",
        primaryNodeIds: ARCHITECTURE_WORLD_MODEL_PRIMARY_IDS,
        nodeIds: collectViewpointNodeIds(ARCHITECTURE_WORLD_MODEL_PRIMARY_IDS, cardById),
      },
      {
        id: "3d-viewpoint-node-model",
        title: "3D viewpoint / node graph branch",
        primaryNodeIds: THREE_D_VIEWPOINT_PRIMARY_IDS,
        nodeIds: collectViewpointNodeIds(THREE_D_VIEWPOINT_PRIMARY_IDS, cardById),
      },
    ],
  };
}

function parseFlagValue(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  if (index >= 0 && argv[index + 1]) {
    return argv[index + 1];
  }
  return fallback;
}

export async function runCardFrameworkGraphExport({
  argv = process.argv.slice(2),
  repoRoot = process.cwd(),
  io = { stdout: process.stdout, stderr: process.stderr },
} = {}) {
  const normalizedRoot = path.resolve(repoRoot);
  const registryPath = toRepoPath(parseFlagValue(argv, "--registry", DEFAULT_REGISTRY_PATH));
  const outPath = toRepoPath(parseFlagValue(argv, "--out", DEFAULT_OUT_PATH));
  const checkMode = argv.includes("--check");
  const report = await collectCardFrameworkReport({ repoRoot: normalizedRoot, registryPath });

  if (!report.summary.ok) {
    io.stderr.write("openclaw card graph export blocked: card framework check failed\n");
    return 1;
  }

  const registry = JSON.parse(await fs.readFile(path.join(normalizedRoot, registryPath), "utf8"));
  const cards = Array.isArray(registry.cards) ? registry.cards : [];
  const graph = buildCardFrameworkGraph(cards, { registryPath, report });
  const outputText = `${JSON.stringify(graph, null, 2)}\n`;
  const absoluteOutPath = path.join(normalizedRoot, outPath);

  if (checkMode) {
    let currentText;
    try {
      currentText = await fs.readFile(absoluteOutPath, "utf8");
    } catch {
      io.stderr.write(`openclaw card graph check failed: missing ${outPath}\n`);
      return 1;
    }
    if (currentText !== outputText) {
      io.stderr.write(`openclaw card graph check failed: stale ${outPath}\n`);
      return 1;
    }
    io.stdout.write(`openclaw card graph check passed: ${outPath}\n`);
    return 0;
  }

  await fs.mkdir(path.dirname(absoluteOutPath), { recursive: true });
  await fs.writeFile(absoluteOutPath, outputText, "utf8");
  io.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        outPath,
        nodes: graph.graph.nodes.length,
        links: graph.graph.links.length,
        viewpoints: graph.viewpoints.length,
        validation: graph.validation?.ok ?? false,
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
  runCardFrameworkGraphExport()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(
        `openclaw card graph export crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
