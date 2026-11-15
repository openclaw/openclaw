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
    if (
      !isRequestedModelUnsupportedError(error) ||
      error.reason !== "unadvertised-model" ||
      error.ambiguous === true ||
      slash <= 0 ||
      slash === model.length - 1
    ) {
      throw error;
    }
    return await apply(model.slice(slash + 1));
  }
}

export async function ensureSessionWithModelRef(
  ensureSession: BaseAcpxRuntime["ensureSession"],
  input: EnsureInput,
): Promise<Awaited<ReturnType<AcpRuntime["ensureSession"]>>> {
  const ensure = (model: string | undefined) =>
    ensureSession(withAcpxSessionOptions({ ...input, model }));
  const requested = input.model?.trim();
  try {
    return requested
      ? await withOpenClawModelRef(requested, ensure)
      : await ensureSession(withAcpxSessionOptions(input));
  } catch (error) {
    if (
      !requested ||
      input.modelExplicit ||
      !isRequestedModelUnsupportedError(error) ||
      error.reason !== "missing-capability"
    ) {
      throw error;
    }
    return { ...(await ensure(undefined)), appliedModel: { kind: "dropped" } };
  }
}
