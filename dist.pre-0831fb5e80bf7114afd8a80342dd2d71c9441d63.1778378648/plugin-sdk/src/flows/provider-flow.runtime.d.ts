import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type ProviderModelPickerEntry } from "../plugins/provider-wizard.js";
import type { FlowContribution } from "./types.js";
type ProviderModelPickerFlowEntry = ProviderModelPickerEntry;
type ProviderModelPickerFlowContribution = FlowContribution & {
    kind: "provider";
    surface: "model-picker";
    providerId: string;
    option: ProviderModelPickerFlowEntry;
    source: "runtime";
};
export declare function resolveProviderModelPickerFlowEntries(params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): ProviderModelPickerFlowEntry[];
export declare function resolveProviderModelPickerFlowContributions(params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): ProviderModelPickerFlowContribution[];
export {};
