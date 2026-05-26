import { n as InteractiveReply, r as InteractiveReplyBlock } from "./payload-BuuA629O.js";

//#region src/channels/plugins/outbound/interactive.d.ts
declare function reduceInteractiveReply<TState>(interactive: InteractiveReply | undefined, initialState: TState, reduce: (state: TState, block: InteractiveReplyBlock, index: number) => TState): TState;
//#endregion
export { reduceInteractiveReply as t };