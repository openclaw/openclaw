import type { InteractiveReply, InteractiveReplyBlock } from "../../../interactive/payload.js";
export { adaptMessagePresentationForChannel, applyPresentationActionLimits, presentationPageSize, } from "./presentation-limits.js";
/**
 * @deprecated Use MessagePresentation helpers for new rendering paths.
 */
export declare function reduceInteractiveReply<TState>(interactive: InteractiveReply | undefined, initialState: TState, reduce: (state: TState, block: InteractiveReplyBlock, index: number) => TState): TState;
