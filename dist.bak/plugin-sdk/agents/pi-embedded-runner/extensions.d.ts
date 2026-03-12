import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionFactory, SessionManager } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import { ensurePiCompactionReserveTokens } from "../pi-settings.js";
export declare function buildEmbeddedExtensionFactories(params: {
    cfg: OpenClawConfig | undefined;
    sessionManager: SessionManager;
    provider: string;
    modelId: string;
    model: Model<Api> | undefined;
}): ExtensionFactory[];
export { ensurePiCompactionReserveTokens };
