import type { ImageContent } from "@earendil-works/pi-ai";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import type { MsgContext } from "../templating.js";
export declare function resolveCurrentTurnImages(params: {
    ctx: MsgContext;
    cfg: OpenClawConfig;
    images?: ImageContent[];
    imageOrder?: PromptImageOrderEntry[];
}): Promise<{
    images?: ImageContent[];
    imageOrder?: PromptImageOrderEntry[];
}>;
