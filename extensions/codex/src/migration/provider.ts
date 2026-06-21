// Codex provider module implements model/runtime integration.
import type {
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";

export function buildCodexMigrationProvider(
  params: {
    runtime?: MigrationProviderContext["runtime"];
  } = {},
): MigrationProviderPlugin {
  return {
    id: "codex",
    label: "Codex",
    description:
      "Inventory and promote Codex CLI skills while keeping Codex native plugins and hooks explicit.",
    async detect(ctx) {
      const { discoverCodexSource, hasCodexSource } = await import("./source.js");
      const source = await discoverCodexSource({
        input: ctx.source,
      });
      const found = hasCodexSource(source);
      return {
        found,
        source: source.root,
        label: "Codex",
        confidence: found ? source.confidence : "low",
        message: found ? "Codex state found." : "Codex state not found.",
      };
    },
    async plan(ctx) {
      const { buildCodexMigrationPlan } = await import("./plan.js");
      return await buildCodexMigrationPlan(ctx);
    },
    async prepareApply(ctx) {
      const { prepareTargetCodexAppServer } = await import("./apply.js");
      return prepareTargetCodexAppServer(ctx);
    },
    async apply(ctx, plan?: MigrationPlan) {
      const { applyCodexMigrationPlan } = await import("./apply.js");
      return await applyCodexMigrationPlan({ ctx, plan, runtime: params.runtime });
    },
  };
}
