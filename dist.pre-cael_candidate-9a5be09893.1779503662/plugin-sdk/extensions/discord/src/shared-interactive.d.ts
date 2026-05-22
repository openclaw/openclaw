import type { InteractiveReply, MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import type { DiscordComponentMessageSpec } from "./components.types.js";
/**
 * @deprecated Use buildDiscordPresentationComponents with MessagePresentation.
 */
export declare function buildDiscordInteractiveComponents(interactive?: InteractiveReply): DiscordComponentMessageSpec | undefined;
export declare function buildDiscordPresentationComponents(presentation?: MessagePresentation): DiscordComponentMessageSpec | undefined;
