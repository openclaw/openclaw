import type { NamedCommandDescriptor } from "./command-group-descriptors.js";
export type CoreCliCommandDescriptor = NamedCommandDescriptor;
export declare const CORE_CLI_COMMAND_DESCRIPTORS: readonly ({
    readonly name: "crestodian";
    readonly description: "Open the interactive setup and repair assistant";
    readonly hasSubcommands: false;
    readonly parentDefaultHelp?: undefined;
} | {
    readonly name: "setup";
    readonly description: "Initialize local config and an agent workspace";
    readonly hasSubcommands: false;
    readonly parentDefaultHelp?: undefined;
} | {
    readonly name: "onboard";
    readonly description: "Interactive onboarding for gateway, workspace, and skills";
    readonly hasSubcommands: false;
    readonly parentDefaultHelp?: undefined;
} | {
    readonly name: "configure";
    readonly description: "Interactive configuration for credentials, channels, gateway, and agent defaults";
    readonly hasSubcommands: false;
    readonly parentDefaultHelp?: undefined;
} | {
    readonly name: "config";
    readonly description: "Non-interactive config helpers (get/set/unset/file/validate). Default: starts guided setup.";
    readonly hasSubcommands: true;
    readonly parentDefaultHelp?: undefined;
} | {
    readonly name: "backup";
    readonly description: "Create and verify local backup archives for OpenClaw state";
    readonly hasSubcommands: true;
    readonly parentDefaultHelp?: undefined;
} | {
    readonly name: "migrate";
    readonly description: "Import state from another agent system";
    readonly hasSubcommands: true;
    readonly parentDefaultHelp?: undefined;
} | {
    readonly name: "doctor";
    readonly description: "Diagnose and repair config, Gateway, plugin, and channel problems";
    readonly hasSubcommands: false;
    readonly parentDefaultHelp?: undefined;
} | {
    readonly name: "dashboard";
    readonly description: "Open the Control UI with your current token";
    readonly hasSubcommands: false;
    readonly parentDefaultHelp?: undefined;
} | {
    readonly name: "reset";
    readonly description: "Reset local config/state (keeps the CLI installed)";
    readonly hasSubcommands: false;
    readonly parentDefaultHelp?: undefined;
} | {
    readonly name: "uninstall";
    readonly description: "Uninstall the gateway service + local data (CLI remains)";
    readonly hasSubcommands: false;
    readonly parentDefaultHelp?: undefined;
} | {
    readonly name: "message";
    readonly description: "Send, read, and manage channel messages";
    readonly hasSubcommands: true;
    readonly parentDefaultHelp?: undefined;
} | {
    readonly name: "mcp";
    readonly description: "Manage OpenClaw MCP config and channel bridge";
    readonly hasSubcommands: true;
    readonly parentDefaultHelp: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "agent";
    readonly description: "Run one agent turn via the Gateway";
    readonly hasSubcommands: false;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "agents";
    readonly description: "Manage isolated agents (workspaces, auth, routing)";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "status";
    readonly description: "Show Gateway, channel, model, and recent-session status";
    readonly hasSubcommands: false;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "health";
    readonly description: "Fetch detailed health from the running Gateway";
    readonly hasSubcommands: false;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "sessions";
    readonly description: "List stored conversation sessions";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "commitments";
    readonly description: "List and manage inferred follow-up commitments";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "tasks";
    readonly description: "Inspect durable background tasks and flows";
    readonly hasSubcommands: true;
})[];
export declare function getCoreCliCommandDescriptors(): ReadonlyArray<CoreCliCommandDescriptor>;
export declare function getCoreCliCommandNames(): string[];
export declare function getCoreCliCommandsWithSubcommands(): string[];
export declare function getCoreCliParentDefaultHelpCommands(): string[];
