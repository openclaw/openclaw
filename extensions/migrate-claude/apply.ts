import path from "node:path";
import { summarizeMigrationItems } from "openclaw/plugin-sdk/migration";
import { writeMigrationReport } from "openclaw/plugin-sdk/migration-runtime";
import type {
  MigrationApplyResult,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildClaudePlan } from "./plan.js";

export async function applyClaudePlan(params: {
  ctx: MigrationProviderContext;
  plan?: MigrationPlan;
  runtime?: MigrationProviderContext["runtime"];
}): Promise<MigrationApplyResult> {
  const plan = params.plan ?? (await buildClaudePlan(params.ctx));
  const reportDir = params.ctx.reportDir ?? path.join(params.ctx.stateDir, "migration", "claude");
  const result: MigrationApplyResult = {
    ...plan,
    summary: summarizeMigrationItems(plan.items),
    backupPath: params.ctx.backupPath,
    reportDir,
  };
  await writeMigrationReport(result, { title: "Claude Migration Report" });
  return result;
}
