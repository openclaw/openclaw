export function buildEmbeddedSandboxInfo(sandbox, execElevated) {
    if (!sandbox?.enabled) {
        return undefined;
    }
    const elevatedAllowed = Boolean(execElevated?.enabled && execElevated.allowed);
    return {
        enabled: true,
        workspaceDir: sandbox.workspaceDir,
        containerWorkspaceDir: sandbox.containerWorkdir,
        workspaceAccess: sandbox.workspaceAccess,
        agentWorkspaceMount: sandbox.workspaceAccess === "ro" ? "/agent" : undefined,
        browserBridgeUrl: sandbox.browser?.bridgeUrl,
        browserNoVncUrl: sandbox.browser?.noVncUrl,
        hostBrowserAllowed: sandbox.browserAllowHostControl,
        ...(elevatedAllowed
            ? {
                elevated: {
                    allowed: true,
                    defaultLevel: execElevated?.defaultLevel ?? "off",
                },
            }
            : {}),
    };
}
