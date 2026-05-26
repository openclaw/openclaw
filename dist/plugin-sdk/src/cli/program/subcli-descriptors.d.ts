import type { NamedCommandDescriptor } from "./command-group-descriptors.js";
export type SubCliDescriptor = NamedCommandDescriptor;
export declare const SUB_CLI_DESCRIPTORS: readonly ({
    readonly parentDefaultHelp?: undefined;
    readonly name: "acp";
    readonly description: "Run and manage ACP-backed coding agents";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "gateway";
    readonly description: "Run, inspect, and query the OpenClaw Gateway";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "daemon";
    readonly description: "Manage the Gateway service (legacy alias)";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "logs";
    readonly description: "Tail Gateway logs locally or via RPC";
    readonly hasSubcommands: false;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "system";
    readonly description: "System events, heartbeat, and presence";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "models";
    readonly description: "List, scan, and set model providers";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "infer";
    readonly description: "Run provider-backed model, media, search, and embedding commands";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "capability";
    readonly description: "Run provider capability commands (fallback alias: infer)";
    readonly hasSubcommands: true;
} | {
    readonly name: "approvals";
    readonly description: "Manage exec approvals (gateway or node host)";
    readonly hasSubcommands: true;
    readonly parentDefaultHelp: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "exec-policy";
    readonly description: "Show or synchronize requested exec policy with host approvals";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "nodes";
    readonly description: "Pair nodes and run node-host commands through the Gateway";
    readonly hasSubcommands: true;
} | {
    readonly name: "devices";
    readonly description: "Device pairing + token management";
    readonly hasSubcommands: true;
    readonly parentDefaultHelp: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "node";
    readonly description: "Run and manage the headless node host service";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "sandbox";
    readonly description: "Manage sandbox containers for agent isolation";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "tui";
    readonly description: "Open a terminal UI connected to the Gateway";
    readonly hasSubcommands: false;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "terminal";
    readonly description: "Open a local terminal UI (alias for tui --local)";
    readonly hasSubcommands: false;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "chat";
    readonly description: "Open a local terminal UI (alias for tui --local)";
    readonly hasSubcommands: false;
} | {
    readonly name: "cron";
    readonly description: "Schedule and inspect Gateway background jobs";
    readonly hasSubcommands: true;
    readonly parentDefaultHelp: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "dns";
    readonly description: "DNS helpers for wide-area discovery (Tailscale + CoreDNS)";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "docs";
    readonly description: "Search the live OpenClaw docs";
    readonly hasSubcommands: false;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "qa";
    readonly description: "Run QA scenarios and launch the private QA debugger UI";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "proxy";
    readonly description: "Run the OpenClaw debug proxy and inspect captured traffic";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "hooks";
    readonly description: "Manage internal agent hooks";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "webhooks";
    readonly description: "Webhook helpers and integrations";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "qr";
    readonly description: "Generate mobile pairing QR/setup code";
    readonly hasSubcommands: false;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "clawbot";
    readonly description: "Legacy clawbot command aliases";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "pairing";
    readonly description: "Secure DM pairing (approve inbound requests)";
    readonly hasSubcommands: true;
} | {
    readonly name: "plugins";
    readonly description: "Install, enable, disable, and inspect plugins";
    readonly hasSubcommands: true;
    readonly parentDefaultHelp: true;
} | {
    readonly name: "channels";
    readonly description: "Add, remove, login, and inspect messaging channels";
    readonly hasSubcommands: true;
    readonly parentDefaultHelp: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "directory";
    readonly description: "Lookup contact and group IDs (self, peers, groups) for supported chat channels";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "security";
    readonly description: "Security tools and local config audits";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "secrets";
    readonly description: "Audit, apply, and reload SecretRef-backed credentials";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "skills";
    readonly description: "List, inspect, and install agent skills";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "update";
    readonly description: "Update OpenClaw and inspect update channel status";
    readonly hasSubcommands: true;
} | {
    readonly parentDefaultHelp?: undefined;
    readonly name: "completion";
    readonly description: "Generate shell completion script";
    readonly hasSubcommands: false;
})[];
export declare function getSubCliEntries(): ReadonlyArray<SubCliDescriptor>;
export declare function getSubCliCommandsWithSubcommands(): string[];
export declare function getSubCliParentDefaultHelpCommands(): string[];
