import type { PluginRegistry } from "./registry.js";
export type PluginCapabilityKind = "cli-backend" | "text-inference" | "embedding" | "speech" | "realtime-transcription" | "realtime-voice" | "media-understanding" | "image-generation" | "video-generation" | "music-generation" | "web-search" | "agent-harness" | "context-engine" | "channel";
export type PluginInspectShape = "hook-only" | "plain-capability" | "hybrid-capability" | "non-capability";
export type PluginCapabilityEntry = {
    kind: PluginCapabilityKind;
    ids: string[];
};
export type PluginShapeSummary = {
    shape: PluginInspectShape;
    capabilityMode: "none" | "plain" | "hybrid";
    capabilityCount: number;
    capabilities: PluginCapabilityEntry[];
    usesLegacyBeforeAgentStart: boolean;
};
export declare function buildPluginShapeSummary(params: {
    plugin: PluginRegistry["plugins"][number];
    report: Pick<PluginRegistry, "hooks" | "typedHooks" | "tools" | "gatewayMethodDescriptors">;
}): PluginShapeSummary;
