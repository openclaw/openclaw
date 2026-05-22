import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MsgContext } from "../templating.js";
import type { HandleCommandsParams } from "./commands-types.js";
export declare const baseCommandTestConfig: OpenClawConfig;
export declare function buildCommandTestParams(commandBody: string, cfg: OpenClawConfig, ctxOverrides?: Partial<MsgContext>, options?: {
    workspaceDir?: string;
}): HandleCommandsParams;
export declare function configureInMemoryTaskRegistryStoreForTests(): void;
export declare function buildPluginsCommandParams(params: {
    commandBodyNormalized: string;
    cfg?: OpenClawConfig;
    workspaceDir?: string;
    gatewayClientScopes?: string[];
}): HandleCommandsParams;
