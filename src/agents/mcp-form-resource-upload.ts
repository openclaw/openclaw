import type { McpAppFormOrigin } from "./mcp-ui-resource.js";

/** Select the workspace adapter only from the existing transport owner's local-file fact. */
export async function prepareMcpAppFormUpload(origin: McpAppFormOrigin) {
  origin.assertCurrent();
  if (origin.runtime.canReadLocalFiles?.(origin.serverName) !== true) {
    return undefined;
  }
  const { createMcpAppWorkspaceUploadProvider } =
    await import("../gateway/mcp-app-form-resources.js");
  const assertCurrent = () => {
    origin.assertCurrent();
    if (origin.runtime.canReadLocalFiles?.(origin.serverName) !== true) {
      throw new Error("MCP form local-file transport changed");
    }
  };
  assertCurrent();
  return createMcpAppWorkspaceUploadProvider({
    workspaceDir: origin.runtime.workspaceDir,
    sessionKey: origin.sessionKey,
    agentId: origin.agentId,
    assertCurrent,
  });
}
