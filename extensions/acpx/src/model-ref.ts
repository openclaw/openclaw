import {
  isRequestedModelUnsupportedError,
  type AcpxRuntime as BaseAcpxRuntime,
} from "acpx/runtime";
import type { AcpRuntime } from "../runtime-api.js";

type DelegateEnsureInput = Parameters<BaseAcpxRuntime["ensureSession"]>[0];
type EnsureInput = Parameters<AcpRuntime["ensureSession"]>[0] &
  Pick<DelegateEnsureInput, "sessionOptions">;

export function withAcpxSessionOptions(input: EnsureInput): DelegateEnsureInput {
  const model = input.model?.trim() || input.sessionOptions?.model;
  const sessionOptions = model ? { ...input.sessionOptions, model } : input.sessionOptions;
  const { modelExplicit: _modelExplicit, thinkingExplicit: _thinkingExplicit, ...rest } = input;
  return { ...rest, ...(sessionOptions ? { sessionOptions } : {}) };
}

/** ACPX's typed, unambiguous pre-wire rejection of a model id the session did not advertise. */
export function isUnadvertisedModelRejection(error: unknown): boolean {
  return (
    isRequestedModelUnsupportedError(error) &&
    error.reason === "unadvertised-model" &&
    error.ambiguous !== true
  );
}

// Try the exact harness id first. ACPX owns live catalog validation and vendor aliases;
// only its typed rejection allows retrying an OpenClaw provider/model reference.
export async function withOpenClawModelRef<T>(
  requested: string,
  apply: (model: string) => Promise<T>,
): Promise<T> {
  try {
    return await apply(requested);
  } catch (error) {
    const model = requested.trim();
    const slash = model.indexOf("/");
    if (!isUnadvertisedModelRejection(error) || slash <= 0 || slash === model.length - 1) {
      throw error;
    }
    return await apply(model.slice(slash + 1));
  }
}

export async function ensureSessionWithModelRef(
  ensureSession: BaseAcpxRuntime["ensureSession"],
  input: EnsureInput,
): Promise<Awaited<ReturnType<AcpRuntime["ensureSession"]>>> {
  const requested = input.model?.trim();
  if (!requested) {
    return await ensureSession(withAcpxSessionOptions(input));
  }
  // A supplied model may be a configured ACP selection; never retry it as no-model.
  return await withOpenClawModelRef(requested, (model) =>
    ensureSession(withAcpxSessionOptions({ ...input, model })),
  );
}
