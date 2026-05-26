import { type ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function resolveDefaultModel(params: {
    cfg: OpenClawConfig;
    agentId?: string;
}): {
    defaultProvider: string;
    defaultModel: string;
    aliasIndex: ModelAliasIndex;
};
