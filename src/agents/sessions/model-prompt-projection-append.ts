import type { PreparedModelPromptProjection } from "../../sessions/user-turn-transcript.types.js";
import type { CustomMessage } from "./messages.js";

export const sessionManagerAppendPromptContext = Symbol("sessionManagerAppendPromptContext");

export type PrepareModelPromptProjection = () => Promise<PreparedModelPromptProjection | undefined>;

const projections = new WeakMap<CustomMessage, PrepareModelPromptProjection>();

/** Prepare after message listeners have finalized the user text, before the carrier commit. */
export function bindModelPromptProjectionAppend(
  carrier: CustomMessage,
  prepare: PrepareModelPromptProjection,
): () => void {
  projections.set(carrier, prepare);
  return () => projections.delete(carrier);
}

export function getModelPromptProjectionAppend(carrier: CustomMessage) {
  return projections.get(carrier);
}
