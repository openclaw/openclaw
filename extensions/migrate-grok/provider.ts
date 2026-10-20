import type {
  MigrationProviderContext,
  MigrationProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";

export function buildGrokMigrationProvider(
  params: { runtime?: MigrationProviderContext["runtime"] } = {},
): MigrationProviderPlugin {
  return {
    id: "grok",
    label: "Grok Bot",
    description:
      "Import Grok Bot agents, verified settings, exported memory, skills, and supported automation/connection definitions.",
    deferredApply: { retrySafe: true },
    async detect(ctx) {
      const { detectGrokSource } = await import("./source/index.js");
      const source = await detectGrokSource({ source: ctx.source });
      return {
        found: source.detected,
        source: source.source,
        label: "Grok Bot",
        confidence: source.detected ? "high" : "low",
        message: source.notes.join(" "),
      };
    },
    async plan(ctx) {
      return await (await import("./plan.js")).buildGrokPlan(ctx);
    },
    async apply(ctx, plan) {
      return await (
        await import("./apply.js")
      ).applyGrokPlan({ ctx, plan, runtime: params.runtime });
    },
  };
}
