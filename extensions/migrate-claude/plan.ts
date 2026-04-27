import { summarizeMigrationItems } from "openclaw/plugin-sdk/migration";
import type {
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { discoverClaudeSource, hasClaudeSource } from "./source.js";
import { resolveTargets } from "./targets.js";

export async function buildClaudePlan(ctx: MigrationProviderContext): Promise<MigrationPlan> {
  const source = await discoverClaudeSource(ctx.source);
  if (!hasClaudeSource(source)) {
    throw new Error(
      `Claude state was not found at ${source.root}. Pass --from <path> if it lives elsewhere.`,
    );
  }
  const targets = resolveTargets(ctx);
  const items: MigrationItem[] = [];
  return {
    providerId: "claude",
    source: source.root,
    target: targets.workspaceDir,
    summary: summarizeMigrationItems(items),
    items,
    warnings: ["Claude migration planning is scaffolded but no items are imported yet."],
    nextSteps: ["Run openclaw doctor after applying the migration."],
    metadata: { agentDir: targets.agentDir },
  };
}
