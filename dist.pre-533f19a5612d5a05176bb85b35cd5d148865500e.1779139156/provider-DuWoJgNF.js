import { n as hasClaudeSource, t as discoverClaudeSource } from "./source-DaTA35cf.js";
import { t as buildClaudePlan } from "./plan-6rnWv7Xa.js";
import { t as applyClaudePlan } from "./apply-Bi2hhoW_.js";
//#region extensions/migrate-claude/provider.ts
function buildClaudeMigrationProvider(params = {}) {
	return {
		id: "claude",
		label: "Claude",
		description: "Import Claude Code and Claude Desktop instructions, MCP servers, and skills.",
		async detect(ctx) {
			const source = await discoverClaudeSource(ctx.source);
			const found = hasClaudeSource(source);
			return {
				found,
				source: source.root,
				label: "Claude",
				confidence: found ? source.confidence : "low",
				message: found ? "Claude state found." : "Claude state not found."
			};
		},
		plan: buildClaudePlan,
		async apply(ctx, plan) {
			return await applyClaudePlan({
				ctx,
				plan,
				runtime: params.runtime
			});
		}
	};
}
//#endregion
export { buildClaudeMigrationProvider as t };
