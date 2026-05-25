import type { ClaworksRobotConfig } from "./config-types.js";
import { isClaworksProductionMode } from "./product-env.js";
import type { ClaworksRuntime } from "./runtime-types.js";

/** Whether sandbox packs may auto-promote after regression (never in production_mode). */
export function shouldAutoPromoteSandbox(
  config: Pick<ClaworksRobotConfig, "production_mode" | "evolution">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isClaworksProductionMode(config, env)) {
    return false;
  }
  return config.evolution?.auto_promote_sandbox === true;
}

/**
 * When `evolution.auto_promote_sandbox=true` (dev/staging only), promote sandbox packs
 * immediately after `evolution.sandbox_ready_for_promotion` without manual HITL.
 */
export function registerEvolutionAutoPromoteHandler(runtime: ClaworksRuntime): void {
  if (!shouldAutoPromoteSandbox(runtime.config)) {
    return;
  }

  runtime.logger?.(
    "[claworks:evolution] auto_promote_sandbox enabled — sandbox regression pass will write production packs",
  );

  runtime.kernel.bus.subscribe("evolution.sandbox_ready_for_promotion", async (event) => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const promotion_id = String(payload.promotion_id ?? "").trim();
    if (!promotion_id || !runtime.evolutionSync) {
      return;
    }

    try {
      const result = await runtime.evolutionSync.promoteSandbox({
        promotion_id,
        approved: true,
        source: "runtime.auto_promote_sandbox",
      });
      runtime.logger?.(`[claworks:evolution] auto_promote ${promotion_id} → ${result.status}`);
    } catch (err) {
      runtime.logger?.(
        `[claworks:evolution] auto_promote failed (${promotion_id}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}
