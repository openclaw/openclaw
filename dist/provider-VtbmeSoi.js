import { n as hasHermesSource, t as discoverHermesSource } from "./source-DBE89LOz.js";
import { t as buildHermesPlan } from "./plan-xt8rdubU.js";
import { t as applyHermesPlan } from "./apply-BgnPZa1t.js";
//#region extensions/migrate-hermes/provider.ts
function buildHermesMigrationProvider(params = {}) {
	return {
		id: "hermes",
		label: "Hermes",
		description: "Import Hermes config, memories, skills, and supported credentials.",
		async detect(ctx) {
			const source = await discoverHermesSource(ctx.source);
			const found = hasHermesSource(source);
			return {
				found,
				source: source.root,
				label: "Hermes",
				confidence: found ? "high" : "low",
				message: found ? "Hermes state found." : "Hermes state not found."
			};
		},
		plan: buildHermesPlan,
		async apply(ctx, plan) {
			return await applyHermesPlan({
				ctx,
				plan,
				runtime: params.runtime
			});
		}
	};
}
//#endregion
export { buildHermesMigrationProvider as t };
