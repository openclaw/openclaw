import type { InteractiveReply, InteractiveReplyBlock } from "../../../interactive/payload.js";
export declare function reduceInteractiveReply<TState>(interactive: InteractiveReply | undefined, initialState: TState, reduce: (state: TState, block: InteractiveReplyBlock, index: number) => TState): TState;
