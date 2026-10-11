import type {
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";

export function buildHermesMigrationProvider(
  params: {
    runtime?: MigrationProviderContext["runtime"];
  } = {},
): MigrationProviderPlugin {
  return {
    id: "hermes",
    label: "Hermes",
    description: "Import Hermes config, memories, skills, and supported credentials.",
    supportedItemKinds: ["memory"],
    async detect(ctx) {
      const { discoverHermesSource, hasHermesSource } = await import("./source.js");
      const { isMemoryOnlyMigration } = await import("./memory.js");
      const source = await discoverHermesSource(ctx.source);
      const found = isMemoryOnlyMigration(ctx)
        ? Boolean(source.memoryPath || source.userPath)
        : hasHermesSource(source);
      return {
        found,
        source: source.root,
        label: "Hermes",
        confidence: found ? "high" : "low",
        message: found ? "Hermes state found." : "Hermes state not found.",
      };
    },
    async plan(ctx) {
      return await (await import("./plan.js")).buildHermesPlan(ctx);
    },
    async apply(ctx, plan?: MigrationPlan) {
      const { applyHermesPlan } = await import("./apply.js");
      return await applyHermesPlan({ ctx, plan, runtime: params.runtime });
    },
  };
}
