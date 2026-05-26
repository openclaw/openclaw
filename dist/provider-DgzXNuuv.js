import { n as hasHermesSource, t as discoverHermesSource } from "./source-DdlSLO_R.js";
import { t as buildHermesPlan } from "./plan-Dy4dj4vD.js";
import { t as applyHermesPlan } from "./apply-CCeSwKJ2.js";
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
