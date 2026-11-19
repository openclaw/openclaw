import type { Model } from "@openclaw/llm-core";
import type { StreamOptions } from "../types.js";
import { awaitProviderLifecycleCallback } from "./transport-stream-shared.js";

/** Applies `onPayload` like the shared adapters: cancellation stops the wait, not the hook. */
export async function applyProviderPayloadHook(
  options: Pick<StreamOptions, "onPayload" | "signal"> | undefined,
  payload: unknown,
  model: Model,
): Promise<unknown> {
  const onPayload = options?.onPayload;
  const replacement = await awaitProviderLifecycleCallback(
    onPayload ? () => onPayload(payload, model) : undefined,
    options?.signal,
  );
  return replacement === undefined ? payload : replacement;
}
