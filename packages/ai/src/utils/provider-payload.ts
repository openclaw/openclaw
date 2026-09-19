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
type PayloadAdmission = (payload: unknown, model: Model) => void;
const normalizingHooks = new WeakMap<
  PayloadHook,
  { run: NormalizingPayloadHook; assertAdmitted?: PayloadAdmission }
>();

/** Let final admission run after the transport's synchronous request normalization. */
export function createNormalizingPayloadHook(
  run: NormalizingPayloadHook,
  assertAdmitted?: PayloadAdmission,
): PayloadHook {
  const hook: PayloadHook = (payload, model) => run(payload, model, (value) => value);
  normalizingHooks.set(hook, { run, assertAdmitted });
  return hook;
}

/** Ordinary hooks still run before required provider normalization, including replacements. */
export async function applyProviderPayloadHook(
  hook: PayloadHook | undefined,
  payload: unknown,
  model: Model,
  normalize: PayloadNormalizer,
): Promise<unknown> {
  const run = hook && normalizingHooks.get(hook)?.run;
  if (run) {
    return run(payload, model, normalize);
  }
  const replacement = await hook?.(payload, model);
  return normalize(replacement === undefined ? payload : replacement);
}

/** A private final-graph assertion, not permission inferred from request fields. */
export function getProviderPayloadAdmission(
  hook: PayloadHook | undefined,
): PayloadAdmission | undefined {
  return hook ? normalizingHooks.get(hook)?.assertAdmitted : undefined;
}
