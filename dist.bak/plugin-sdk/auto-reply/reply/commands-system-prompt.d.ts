import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { EmbeddedContextFile } from "../../agents/pi-embedded-helpers.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import type { WorkspaceBootstrapFile } from "../../agents/workspace.js";
import type { HandleCommandsParams } from "./commands-types.js";
export type CommandsSystemPromptBundle = {
    systemPrompt: string;
    tools: AgentTool[];
    skillsPrompt: string;
    bootstrapFiles: WorkspaceBootstrapFile[];
    injectedFiles: EmbeddedContextFile[];
    sandboxRuntime: ReturnType<typeof resolveSandboxRuntimeStatus>;
};
export declare function resolveCommandsSystemPromptBundle(params: HandleCommandsParams): Promise<CommandsSystemPromptBundle>;
