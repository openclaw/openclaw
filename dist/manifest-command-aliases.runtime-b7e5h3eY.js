import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { n as resolveManifestCommandAliasOwnerInRegistry, r as resolveManifestToolOwnerInRegistry } from "./manifest-command-aliases-BaxKypWl.js";
import { n as isManifestPluginAvailableForControlPlane, o as loadManifestMetadataRegistry, s as loadManifestMetadataSnapshot } from "./manifest-contract-eligibility-LkT7g78Y.js";
import { t as resolveManifestActivationPluginIds } from "./activation-planner-Cd6anAX7.js";
import { t as hasManifestToolAvailability } from "./manifest-tool-availability-6BoazIq-.js";
//#region src/plugins/manifest-command-aliases.runtime.ts
function resolveManifestCommandAliasOwner(params) {
	const registry = params.registry ?? loadManifestMetadataRegistry({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	}).manifestRegistry;
	return resolveManifestCommandAliasOwnerInRegistry({
		command: params.command,
		registry
	});
}
function resolveManifestCliCommandSurfaceOwner(params) {
	const normalizedCommand = normalizeOptionalLowercaseString(params.command);
	if (!normalizedCommand) return;
	if (params.registry) return resolveManifestCommandAliasOwnerInRegistry({
		command: normalizedCommand,
		registry: params.registry
	})?.pluginId;
	return resolveManifestActivationPluginIds({
		trigger: {
			kind: "command",
			command: normalizedCommand
		},
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	})[0];
}
/**
* Resolve which plugin owns an agent-tool name, applying control-plane
* availability filters so disabled/denied plugins are not falsely attributed.
*
* Behavior:
* - Walks the full manifest snapshot (not the lighter-weight registry view) so
*   per-tool `configSignals`/`authSignals` are visible.
* - Skips plugins that fail `isManifestPluginAvailableForControlPlane`
*   (`plugins.allow` / `plugins.deny` / `plugins.entries[id].enabled` /
*   installed-index).
* - For matched tools, runs `hasManifestToolAvailability` to check the
*   tool's own configSignals (e.g. Feishu's `appId`/`appSecret` gate).
* - Reports `availability: "loaded"` when both filters pass, enough for a
*   direct "available from this plugin" diagnostic.
* - Reports `availability: "manifest-only"` when the manifest declares
*   ownership but availability is not provable from manifest alone (e.g.
*   per-account `enabled` flags or per-tool toggles that are runtime-only).
*   Caller should soften the wording to "may be provided by".
*
* Falls back to the pure registry walk only when an explicit registry is
* supplied (no snapshot to filter against).
*/
function resolveManifestToolOwner(params) {
	if (params.registry) return resolveManifestToolOwnerInRegistry({
		toolName: params.toolName,
		registry: params.registry
	});
	const normalizedToolName = normalizeOptionalLowercaseString(params.toolName);
	if (!normalizedToolName) return;
	const snapshot = loadManifestMetadataSnapshot({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	const env = params.env ?? process.env;
	for (const plugin of snapshot.plugins) {
		const tools = plugin.contracts?.tools;
		if (!tools || tools.length === 0) continue;
		const match = tools.find((entry) => normalizeOptionalLowercaseString(entry) === normalizedToolName);
		if (!match) continue;
		if (!isManifestPluginAvailableForControlPlane({
			snapshot,
			plugin,
			config: params.config
		})) continue;
		const toolAvailable = hasManifestToolAvailability({
			plugin,
			toolNames: [match],
			config: params.config,
			env
		});
		return {
			toolName: match,
			pluginId: plugin.id,
			availability: toolAvailable ? "loaded" : "manifest-only"
		};
	}
}
//#endregion
export { resolveManifestCliCommandSurfaceOwner, resolveManifestCommandAliasOwner, resolveManifestToolOwner };
