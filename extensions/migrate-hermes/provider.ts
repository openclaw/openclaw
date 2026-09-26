// Migrate Hermes provider module implements model/runtime integration.
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type {
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";

// Registration exposes the provider contract without loading migration execution.
const loadApply = createLazyRuntimeModule(() => import("./apply.js"));
const loadMemory = createLazyRuntimeModule(() => import("./memory.js"));
const loadPlan = createLazyRuntimeModule(() => import("./plan.js"));
const loadSource = createLazyRuntimeModule(() => import("./source.js"));

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
      const { discoverHermesSource, hasHermesSource } = await loadSource();
      const { isMemoryOnlyMigration } = await loadMemory();
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
      return await (await loadPlan()).buildHermesPlan(ctx);
    },
    async apply(ctx, plan?: MigrationPlan) {
      const { applyHermesPlan } = await loadApply();
      return await applyHermesPlan({ ctx, plan, runtime: params.runtime });
    },
  };
}
