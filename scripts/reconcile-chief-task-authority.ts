import fs from "node:fs/promises";
import { loadConfig } from "../src/config/config.js";
import {
  reconcileChiefTaskAuthority,
  resolveChiefTaskLedgerPath,
  type ChiefTaskRecord,
} from "../src/infra/chief-task-ledger.js";

type CliArgs = {
  configPath?: string;
  agentId: string;
  json: boolean;
};

type LedgerShape = {
  version?: number;
  tasks?: Record<string, ChiefTaskRecord>;
};

type LedgerSummary = {
  version: number | null;
  totalTasks: number;
  nonTerminalTasks: number;
  trackedTasksWithAuthority: number;
  nonTerminalMissingAuthority: number;
  legacyLocalTerminalCount: number;
};

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {
    agentId: "chief",
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") {
      result.configPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--agent") {
      result.agentId = (argv[i + 1] ?? "").trim() || "chief";
      i += 1;
      continue;
    }
    if (arg === "--json") {
      result.json = true;
    }
  }
  return result;
}

async function readLedger(filePath: string): Promise<LedgerShape | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as LedgerShape;
  } catch {
    return null;
  }
}

function isTrackedTask(task: ChiefTaskRecord): boolean {
  return String(task.source ?? "").trim().toLowerCase() !== "internal";
}

function isTerminalTask(task: ChiefTaskRecord): boolean {
  const status = String(task.status ?? "").trim().toLowerCase();
  return status === "done" || status === "cancelled";
}

function isLegacyLocalTerminalTask(task: ChiefTaskRecord): boolean {
  return (
    task.legacyLocalTerminal === true ||
    (isTerminalTask(task) && isTrackedTask(task) && !String(task.paperclipIssueId ?? "").trim())
  );
}

function summarizeLedger(ledger: LedgerShape | null): LedgerSummary {
  const tasks = Object.values(ledger?.tasks ?? {});
  const nonTerminalTasks = tasks.filter((task) => !isTerminalTask(task));
  const trackedTasks = tasks.filter((task) => isTrackedTask(task));
  const trackedTasksWithAuthority = trackedTasks.filter((task) =>
    Boolean(String(task.paperclipIssueId ?? "").trim()),
  );
  const nonTerminalMissingAuthority = nonTerminalTasks.filter((task) => {
    return isTrackedTask(task) && !String(task.paperclipIssueId ?? "").trim();
  });
  const legacyLocalTerminalCount = tasks.filter((task) => isLegacyLocalTerminalTask(task)).length;
  return {
    version: typeof ledger?.version === "number" ? ledger.version : null,
    totalTasks: tasks.length,
    nonTerminalTasks: nonTerminalTasks.length,
    trackedTasksWithAuthority: trackedTasksWithAuthority.length,
    nonTerminalMissingAuthority: nonTerminalMissingAuthority.length,
    legacyLocalTerminalCount,
  };
}

function buildDiff(before: LedgerShape | null, after: LedgerShape | null) {
  const beforeTasks = before?.tasks ?? {};
  const afterTasks = after?.tasks ?? {};
  const allTaskIds = new Set<string>([...Object.keys(beforeTasks), ...Object.keys(afterTasks)]);
  let authorityBackfilledCount = 0;
  let legacyMarkedCount = 0;
  let legacyClearedCount = 0;
  for (const taskId of allTaskIds) {
    const beforeTask = beforeTasks[taskId];
    const afterTask = afterTasks[taskId];
    const beforeIssueId = String(beforeTask?.paperclipIssueId ?? "").trim();
    const afterIssueId = String(afterTask?.paperclipIssueId ?? "").trim();
    if (!beforeIssueId && afterIssueId) {
      authorityBackfilledCount += 1;
    }
    if (beforeTask?.legacyLocalTerminal !== true && afterTask?.legacyLocalTerminal === true) {
      legacyMarkedCount += 1;
    }
    if (beforeTask?.legacyLocalTerminal === true && afterTask?.legacyLocalTerminal !== true) {
      legacyClearedCount += 1;
    }
  }
  return {
    authorityBackfilledCount,
    legacyMarkedCount,
    legacyClearedCount,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.configPath ?? process.env.OPENCLAW_CONFIG_PATH ?? "C:/Users/dxhph/.openclaw/openclaw.json";
  const cfg = loadConfig(configPath);
  const ledgerPath = resolveChiefTaskLedgerPath(cfg, args.agentId);
  const beforeLedger = await readLedger(ledgerPath);
  const beforeSummary = summarizeLedger(beforeLedger);
  const reconciledLedger = await reconcileChiefTaskAuthority({
    cfg,
    agentId: args.agentId,
  });
  const afterLedger = await readLedger(ledgerPath);
  const effectiveAfterLedger = afterLedger ?? reconciledLedger;
  const afterSummary = summarizeLedger(effectiveAfterLedger);
  const diff = buildDiff(beforeLedger, effectiveAfterLedger);
  const payload = {
    configPath,
    agentId: args.agentId,
    ledgerPath,
    before: beforeSummary,
    after: afterSummary,
    diff,
  };
  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`Config: ${payload.configPath}`);
  console.log(`Agent: ${payload.agentId}`);
  console.log(`Ledger: ${payload.ledgerPath}`);
  console.log(
    `Before: version=${beforeSummary.version ?? "none"} total=${beforeSummary.totalTasks} nonTerminalMissingAuthority=${beforeSummary.nonTerminalMissingAuthority} legacyLocalTerminal=${beforeSummary.legacyLocalTerminalCount}`,
  );
  console.log(
    `After: version=${afterSummary.version ?? "none"} total=${afterSummary.totalTasks} nonTerminalMissingAuthority=${afterSummary.nonTerminalMissingAuthority} legacyLocalTerminal=${afterSummary.legacyLocalTerminalCount}`,
  );
  console.log(
    `Diff: authorityBackfilled=${diff.authorityBackfilledCount} legacyMarked=${diff.legacyMarkedCount} legacyCleared=${diff.legacyClearedCount}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
