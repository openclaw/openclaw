import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { CodexAppServerExtensionContext, CodexAppServerExtensionFactory, CodexAppServerToolResultEvent } from "../../plugins/codex-app-server-extension-types.js";
export declare function createCodexAppServerToolResultExtensionRunner(ctx: CodexAppServerExtensionContext, factories?: CodexAppServerExtensionFactory[]): {
    applyToolResultExtensions(event: CodexAppServerToolResultEvent): Promise<AgentToolResult<unknown>>;
};
