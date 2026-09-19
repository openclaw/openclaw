/**
 * Maps OpenClaw model requests onto the model IDs an ACP harness advertises. Harnesses such
 * as Cursor advertise opaque parameterized IDs (`composer-2.5[fast=true]`) rather than the
 * selector a user types, and OpenClaw refs carry a provider prefix the harness never sees.
 * Only a unique advertised ID is selected.
 */
import {
  AcpxRuntime as BaseAcpxRuntime,
  isRequestedModelUnsupportedError,
  type SessionAgentOptions,
} from "acpx/runtime";
import { AcpRuntimeError, type AcpRuntime } from "../runtime-api.js";
import type { AcpLoadedSessionRecord } from "./runtime-session-store.js";

type EnsureInput = Parameters<AcpRuntime["ensureSession"]>[0];
type EnsuredHandle = Awaited<ReturnType<AcpRuntime["ensureSession"]>>;
type DelegateEnsureInput = Parameters<BaseAcpxRuntime["ensureSession"]>[0];

/** Returns the one advertised model ID a request names, or undefined when none or several match. */
export function resolveAdvertisedModelId(
  requested: string,
  advertised: readonly string[] | undefined,
): string | undefined {
  const model = requested.trim();
  if (!model || !advertised?.length) {
    return undefined;
  }
  const slash = model.indexOf("/");
  const candidates = slash > 0 ? [model, model.slice(slash + 1)] : [model];
  const exact = candidates.find((candidate) => advertised.includes(candidate));
  if (exact) {
    return exact;
  }
  for (const candidate of candidates) {
    const matches = advertised.filter((id) => id.startsWith(`${candidate}[`));
    if (matches.length === 1) {
      return matches[0];
    }
  }
  return undefined;
}

export function withAcpxSessionOptions(input: EnsureInput): DelegateEnsureInput {
  // SAFETY: callers may pass acpx session options that OpenClaw's ensure type does not name.
  const existingOptions = (input as { sessionOptions?: SessionAgentOptions }).sessionOptions;
  const model = input.model?.trim() || existingOptions?.model;
  const sessionOptions = model ? { ...existingOptions, model } : existingOptions;
  const { modelExplicit: _modelExplicit, thinkingExplicit: _thinkingExplicit, ...rest } = input;
  const delegateInput = { ...rest, ...(sessionOptions ? { sessionOptions } : {}) };
  // SAFETY: OpenClaw's ensure input is acpx's plus the explicit-selection flags removed above.
  return delegateInput as DelegateEnsureInput;
}

/**
 * Opens the session, falling back to catalog selection when acpx rejects a request that does
 * not name an advertised ID verbatim. The handle keeps no applied-model override, so session
 * metadata keeps the caller's OpenClaw ref; the `model` control maps it to the advertised ID.
 * A derived model is dropped only when the harness has no model control at all; a request
 * that no unique advertised ID matches remains a visible failure.
 */
export async function ensureSessionWithAdvertisedModel(params: {
  delegate: BaseAcpxRuntime;
  loadRecord: (handle: EnsuredHandle) => Promise<AcpLoadedSessionRecord>;
  input: EnsureInput;
}): Promise<EnsuredHandle> {
  const { delegate, input } = params;
  const requested = input.model?.trim();
  try {
    return await delegate.ensureSession(withAcpxSessionOptions(input));
  } catch (error) {
    if (!requested || !isRequestedModelUnsupportedError(error)) {
      throw error;
    }
    const modelless = () =>
      delegate.ensureSession(withAcpxSessionOptions({ ...input, model: undefined }));
    if (error.reason === "missing-capability") {
      if (input.modelExplicit) {
        throw error;
      }
      return { ...(await modelless()), appliedModel: { kind: "dropped" } };
    }
    let handle: EnsuredHandle;
    try {
      handle = await modelless();
    } catch {
      throw error;
    }
    // From here the reopened session is ours: every failure must release it.
    try {
      const selected = resolveAdvertisedModelId(
        requested,
        (await params.loadRecord(handle))?.acpx?.available_models,
      );
      if (!selected) {
        throw error;
      }
      await delegate.setModel({ handle, model: selected });
      if ((await params.loadRecord(handle))?.acpx?.current_model_id !== selected) {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `ACP agent "${input.agent}" did not confirm model "${selected}" for requested model "${requested}".`,
        );
      }
      return handle;
    } catch (selectionError) {
      await retireSession(delegate, handle);
      throw selectionError;
    }
  }
}

// Retire the reopened session the way a reset does: acpx stops its process and marks the record
// `reset_on_next_ensure`, so a same-key retry (or a restarted Gateway) starts fresh instead of
// reusing this model-less record. A plain release would leave it reusable.
async function retireSession(delegate: BaseAcpxRuntime, handle: EnsuredHandle) {
  try {
    await delegate.prepareFreshSession({ handle });
  } catch {
    // The model failure is the error to report; the runtime still owns this session's cleanup.
  }
}
