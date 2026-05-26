import { type ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { type ModelDirectiveSelection } from "./model-selection.js";
export declare function resolveModelSelectionFromDirective(params: {
    directives: InlineDirectives;
    cfg: OpenClawConfig;
    agentDir: string;
    defaultProvider: string;
    defaultModel: string;
    aliasIndex: ModelAliasIndex;
    allowedModelKeys: Set<string>;
    allowedModelCatalog: Array<{
        provider: string;
        id?: string;
        name?: string;
    }>;
    provider: string;
}): {
    modelSelection?: ModelDirectiveSelection;
    profileOverride?: string;
    errorText?: string;
};
