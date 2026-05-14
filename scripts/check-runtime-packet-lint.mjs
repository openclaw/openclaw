import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_TARGETS = [
  {
    id: "runtime-packet-lint-core",
    filePath: "src/agents/tools/runtime-packet-lint.ts",
    requiredSnippets: [
      "validateRuntimeExecutionPacket",
      "readRuntimeExecutionPacket",
      "stripRuntimeExecutionPackets",
      "foundationRefs",
      "confidenceLoop",
      "SIDE_EFFECT_TASK_RE",
    ],
  },
  {
    id: "sessions-spawn-side-effect-gate",
    filePath: "src/agents/tools/sessions-spawn-tool.ts",
    requiredSnippets: [
      "validateRuntimeExecutionPacket",
      "readRuntimeExecutionPacket",
      "taskText: task",
      "if (!packetLint.ok)",
    ],
    testPath: "src/agents/tools/sessions-spawn-tool.test.ts",
    requiredTestSnippets: [
      "rejects side-effectful spawn tasks without an execution packet",
      "executionPacketForTest",
      "requires an executionPacket",
    ],
  },
  {
    id: "cron-agent-turn-side-effect-gate",
    filePath: "src/agents/tools/cron-tool.ts",
    requiredSnippets: [
      "lintCronAgentTurnExecutionPacket",
      "validateRuntimeExecutionPacket",
      'payload?.kind !== "agentTurn"',
      "stripRuntimeExecutionPackets",
    ],
    testPath: "src/agents/tools/cron-tool.runtime-packet.test.ts",
    requiredTestSnippets: [
      "rejects side-effectful cron agentTurn jobs without an execution packet",
      "allows side-effectful cron agentTurn jobs with an execution packet",
      "strips cron execution packet aliases before forwarding",
      "requires an executionPacket",
    ],
  },
];

function readRepoText(repoRoot, relativePath) {
  const fullPath = path.join(repoRoot, relativePath);
  if (!existsSync(fullPath)) {
    return null;
  }
  return readFileSync(fullPath, "utf8");
}

function collectMissingSnippets(source, snippets) {
  return snippets.filter((snippet) => !source.includes(snippet));
}

export function collectRuntimePacketLintErrorsFromSources(sourceByPath, targets = DEFAULT_TARGETS) {
  const errors = [];
  for (const target of targets) {
    const source = sourceByPath.get(target.filePath);
    if (source == null) {
      errors.push(`${target.id}: missing ${target.filePath}`);
      continue;
    }
    for (const snippet of collectMissingSnippets(source, target.requiredSnippets)) {
      errors.push(`${target.id}: ${target.filePath} is missing "${snippet}"`);
    }
    if (target.testPath) {
      const testSource = sourceByPath.get(target.testPath);
      if (testSource == null) {
        errors.push(`${target.id}: missing ${target.testPath}`);
        continue;
      }
      for (const snippet of collectMissingSnippets(testSource, target.requiredTestSnippets)) {
        errors.push(`${target.id}: ${target.testPath} is missing "${snippet}"`);
      }
    }
  }
  return errors;
}

export function collectRuntimePacketLintReport({
  repoRoot = process.cwd(),
  targets = DEFAULT_TARGETS,
} = {}) {
  const sourceByPath = new Map();
  for (const target of targets) {
    sourceByPath.set(target.filePath, readRepoText(repoRoot, target.filePath));
    if (target.testPath) {
      sourceByPath.set(target.testPath, readRepoText(repoRoot, target.testPath));
    }
  }
  const errors = collectRuntimePacketLintErrorsFromSources(sourceByPath, targets);
  return {
    ok: errors.length === 0,
    source: "runtime-packet-lint-coverage",
    targetCount: targets.length,
    targets: targets.map((target) => ({
      id: target.id,
      filePath: target.filePath,
      testPath: target.testPath,
    })),
    errors,
  };
}

function parseArgs(argv) {
  const args = {
    json: false,
    repoRoot: process.cwd(),
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--root") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing --root value");
      }
      args.repoRoot = path.resolve(next);
      index++;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = collectRuntimePacketLintReport({ repoRoot: args.repoRoot });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (!report.ok) {
    for (const error of report.errors) {
      process.stderr.write(`${error}\n`);
    }
  }
  process.exitCode = report.ok ? 0 : 1;
  return report;
}

if (import.meta.main) {
  main();
}
