import type { Model, StreamOptions } from "../types.js";

type PayloadHook = NonNullable<StreamOptions["onPayload"]>;
type PayloadNormalizer = (payload: unknown) => unknown;
type NormalizingPayloadHook = (
  payload: unknown,
  model: Model,
  normalize: PayloadNormalizer,
) => ReturnType<PayloadHook>;

// Key by the hook, not its containing options: provider adapters copy options
// while retaining callbacks. This is an internal ordering contract, not authority.
const normalizingHooks = new WeakMap<PayloadHook, NormalizingPayloadHook>();

/** Let final admission run after the transport's synchronous request normalization. */
export function createNormalizingPayloadHook(run: NormalizingPayloadHook): PayloadHook {
  const hook: PayloadHook = (payload, model) => run(payload, model, (value) => value);
  normalizingHooks.set(hook, run);
  return hook;
}

/** Ordinary hooks still run before required provider normalization, including replacements. */
export async function applyProviderPayloadHook(
  hook: PayloadHook | undefined,
  payload: unknown,
  model: Model,
  normalize: PayloadNormalizer,
): Promise<unknown> {
  const run = hook && normalizingHooks.get(hook);
  if (run) {
    return run(payload, model, normalize);
  }
  const replacement = await hook?.(payload, model);
  return normalize(replacement === undefined ? payload : replacement);
}
