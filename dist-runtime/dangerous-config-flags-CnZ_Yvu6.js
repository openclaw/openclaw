//#region src/security/dangerous-config-flags.ts
function collectEnabledInsecureOrDangerousFlags(cfg) {
	const enabledFlags = [];
	if (cfg.gateway?.controlUi?.allowInsecureAuth === true) enabledFlags.push("gateway.controlUi.allowInsecureAuth=true");
	if (cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true) enabledFlags.push("gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true");
	if (cfg.gateway?.controlUi?.dangerouslyDisableDeviceAuth === true) enabledFlags.push("gateway.controlUi.dangerouslyDisableDeviceAuth=true");
	if (cfg.hooks?.gmail?.allowUnsafeExternalContent === true) enabledFlags.push("hooks.gmail.allowUnsafeExternalContent=true");
	if (Array.isArray(cfg.hooks?.mappings)) {
		for (const [index, mapping] of cfg.hooks.mappings.entries()) if (mapping?.allowUnsafeExternalContent === true) enabledFlags.push(`hooks.mappings[${index}].allowUnsafeExternalContent=true`);
	}
	if (cfg.tools?.exec?.applyPatch?.workspaceOnly === false) enabledFlags.push("tools.exec.applyPatch.workspaceOnly=false");
	return enabledFlags;
}
//#endregion
export { collectEnabledInsecureOrDangerousFlags as t };
