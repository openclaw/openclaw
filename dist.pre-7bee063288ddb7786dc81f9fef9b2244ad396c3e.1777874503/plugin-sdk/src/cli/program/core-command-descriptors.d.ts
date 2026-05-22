import type { NamedCommandDescriptor } from "./command-group-descriptors.js";
export type CoreCliCommandDescriptor = NamedCommandDescriptor;
export declare const CORE_CLI_COMMAND_DESCRIPTORS: readonly ({
    readonly name: "crestodian";
    readonly description: "Open the ring-zero setup and repair helper";
    readonly hasSubcommands: false;
} | {
    readonly name: "setup";
    readonly description: "Initialize local config and agent workspace";
    readonly hasSubcommands: false;
} | {
    readonly name: "onboard";
    readonly description: "Interactive onboarding for gateway, workspace, and skills";
    readonly hasSubcommands: false;
} | {
    readonly name: "configure";
    readonly description: "Interactive configuration for credentials, channels, gateway, and agent defaults";
    readonly hasSubcommands: false;
} | {
    readonly name: "config";
    readonly description: "Non-interactive config helpers (get/set/unset/file/validate). Default: starts guided setup.";
    readonly hasSubcommands: true;
} | {
    readonly name: "backup";
    readonly description: "Create and verify local backup archives for OpenClaw state";
    readonly hasSubcommands: true;
} | {
    readonly name: "migrate";
    readonly description: "Import state from another agent system";
    readonly hasSubcommands: true;
} | {
    readonly name: "doctor";
    readonly description: "Health checks + quick fixes for the gateway and channels";
    readonly hasSubcommands: false;
} | {
    readonly name: "dashboard";
    readonly description: "Open the Control UI with your current token";
    readonly hasSubcommands: false;
} | {
    readonly name: "reset";
    readonly description: "Reset local config/state (keeps the CLI installed)";
    readonly hasSubcommands: false;
} | {
    readonly name: "uninstall";
    readonly description: "Uninstall the gateway service + local data (CLI remains)";
    readonly hasSubcommands: false;
} | {
    readonly name: "message";
    readonly description: "Send, read, and manage messages";
    readonly hasSubcommands: true;
} | {
    readonly name: "mcp";
    readonly description: "Manage OpenClaw MCP config and channel bridge";
    readonly hasSubcommands: true;
} | {
    readonly name: "agent";
    readonly description: "Run one agent turn via the Gateway";
    readonly hasSubcommands: false;
} | {
    readonly name: "agents";
    readonly description: "Manage isolated agents (workspaces, auth, routing)";
    readonly hasSubcommands: true;
} | {
    readonly name: "status";
    readonly description: "Show channel health and recent session recipients";
    readonly hasSubcommands: false;
} | {
    readonly name: "health";
    readonly description: "Fetch health from the running gateway";
    readonly hasSubcommands: false;
} | {
    readonly name: "sessions";
    readonly description: "List stored conversation sessions";
    readonly hasSubcommands: true;
} | {
    readonly name: "commitments";
    readonly description: "List and manage inferred follow-up commitments";
    readonly hasSubcommands: true;
} | {
    readonly name: "tasks";
    readonly description: "Inspect durable background task state";
    readonly hasSubcommands: true;
})[];
export declare function getCoreCliCommandDescriptors(): ReadonlyArray<CoreCliCommandDescriptor>;
export declare function getCoreCliCommandNames(): string[];
export declare function getCoreCliCommandsWithSubcommands(): string[];
