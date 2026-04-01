import { loadConfig } from "../src/config/config.js";
import {
  archiveChiefTaskLedger,
  resolveChiefTaskLedgerArchivePath,
  resolveChiefTaskLedgerPath,
} from "../src/infra/chief-task-ledger.js";

type CliArgs = {
  configPath?: string;
  agentId: string;
  json: boolean;
  retentionDays?: number;
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
    if (arg === "--retention-days") {
      const parsed = Number.parseInt(argv[i + 1] ?? "", 10);
      if (Number.isFinite(parsed)) {
        result.retentionDays = parsed;
      }
      i += 1;
      continue;
    }
    if (arg === "--json") {
      result.json = true;
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.configPath ?? process.env.OPENCLAW_CONFIG_PATH ?? "C:/Users/dxhph/.openclaw/openclaw.json";
  const cfg = loadConfig(configPath);
  const result = await archiveChiefTaskLedger({
    cfg,
    agentId: args.agentId,
    retentionDays: args.retentionDays,
  });
  const payload = {
    configPath,
    agentId: args.agentId,
    ledgerPath: resolveChiefTaskLedgerPath(cfg, args.agentId),
    archivePath: resolveChiefTaskLedgerArchivePath(cfg, args.agentId),
    archiveLastRunAt: result.archiveLastRunAt,
    archiveLastOutcome: result.archiveLastOutcome,
    archivedTaskIds: result.archivedTaskIds,
    archivedLegacyTerminalCount: result.archivedLegacyTerminalCount,
    retainedLegacyLocalTerminalCount: result.retainedLegacyLocalTerminalCount,
  };
  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`Config: ${payload.configPath}`);
  console.log(`Agent: ${payload.agentId}`);
  console.log(`Ledger: ${payload.ledgerPath}`);
  console.log(`Archive: ${payload.archivePath}`);
  console.log(
    `Archive run: ${new Date(payload.archiveLastRunAt).toISOString()} outcome=${payload.archiveLastOutcome}`,
  );
  console.log(`Archived task ids: ${payload.archivedTaskIds.length > 0 ? payload.archivedTaskIds.join(", ") : "none"}`);
  console.log(`Archived legacy terminal count: ${payload.archivedLegacyTerminalCount}`);
  console.log(`Retained legacy terminal count: ${payload.retainedLegacyLocalTerminalCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
