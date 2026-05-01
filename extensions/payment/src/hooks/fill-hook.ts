/**
 * fill-hook.ts — before_tool_call hook for browser "fill" actions.
 *
 * Security model / approval-granted continuation pattern
 * -------------------------------------------------------
 * The SDK's `PluginHookBeforeToolCallResult` supports returning BOTH
 * `requireApproval` AND `params` in the same object. When `requireApproval` is
 * present, the runtime calls `requestPluginToolApproval`, which on approval
 * returns `{ blocked: false, params: mergeParamsWithApprovalOverrides(baseParams, overrideParams) }`
 * where `overrideParams` is the `params` field from this hook's return value.
 *
 * Therefore: this hook eagerly retrieves card secrets, builds the rewritten
 * `params` (with real card values substituted for sentinels), and returns
 * `{ requireApproval, params: rewrittenParams }` in ONE response. The runtime
 * holds the rewritten params in memory during the approval wait and applies them
 * only if the user approves. On deny/timeout, the tool call is blocked and the
 * rewritten params are discarded without ever reaching the LLM transcript.
 *
 * This is NOT a two-phase re-call pattern. The hook is NOT called again after
 * approval. The substitution always happens eagerly, before returning.
 *
 * Sentinel resolution — 3-tier lookup
 * -----------------------------------
 * `resolveSentinel` resolves a sentinel `field` against the adapter's
 * `CredentialFillData`:
 *
 *   Tier 1 — card secrets (closed type-safe switch): pan, cvv, exp_*
 *   Tier 2 — known buyer profile fields (closed type-safe checks): holder_name,
 *            billing_*. Returns "not available" when the profile lacks the value.
 *   Tier 3 — forward-compat extras (open Record<string, string>): any field
 *            the provider exposed that isn't in tiers 1/2.
 *
 * Unknown fields fail fast with a `block: true` and a description of the
 * available fields for this credential.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PaymentManager } from "../payments.js";
import { CardUnavailableError } from "../providers/base.js";
import type { CredentialFillData } from "../providers/base.js";
import { handleMap } from "../store.js";
import { findSentinelsInFields, isFillSentinel } from "./sentinel.js";

// ---------------------------------------------------------------------------
// Types — mirrored from SDK hook-types.ts for local use
// ---------------------------------------------------------------------------

type BeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
};

type BeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: {
    title: string;
    description: string;
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;
    timeoutBehavior?: "allow" | "deny";
    pluginId?: string;
  };
};

type HookContext = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FillHookOptions = {
  manager: PaymentManager;
  /** For audit logging: path to the JSONL store. Optional in V1; if absent, skip audit writes. */
  storePath?: string;
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFillHook(api: OpenClawPluginApi, opts: FillHookOptions): void {
  api.on("before_tool_call", async (event, _ctx: HookContext) => {
    return await handleBrowserBeforeToolCall(event, opts);
  });
}

// ---------------------------------------------------------------------------
// Hook handler (exported for testability)
// ---------------------------------------------------------------------------

export async function handleBrowserBeforeToolCall(
  event: BeforeToolCallEvent,
  opts: FillHookOptions,
): Promise<BeforeToolCallResult | undefined> {
  // 1. Scope: only handle browser tool's fill action
  if (event.toolName !== "browser") return undefined;

  const params = event.params;
  const request = params["request"] as
    | { kind?: string; fields?: unknown; targetId?: unknown }
    | undefined;
  if (request?.kind !== "fill") return undefined;

  const fields = request.fields;
  if (!Array.isArray(fields)) return undefined;

  // 2. Find sentinels
  const sentinels = findSentinelsInFields(fields as Array<{ value?: unknown }>);
  if (sentinels.length === 0) return undefined;

  // 3. Validate handles exist and aren't expired
  const handleIds = [...new Set(sentinels.map((s) => s.sentinel.$paymentHandle))];
  for (const hid of handleIds) {
    const meta = handleMap.get(hid);
    if (!meta) {
      return {
        block: true,
        blockReason: `payment fill: unknown handle "${hid}". Issue a virtual card first.`,
      };
    }
    if (meta.validUntil && new Date(meta.validUntil) < new Date()) {
      return {
        block: true,
        blockReason: `payment fill: handle "${hid}" expired at ${meta.validUntil}. Issue a new card.`,
      };
    }
  }

  // 4. Eagerly retrieve secrets and build rewritten params.
  //
  // SECURITY: This is the only call site of retrieveCardSecretsForHook in the plugin.
  //
  // We retrieve secrets BEFORE returning requireApproval because the SDK's approval
  // continuation pattern merges the returned `params` field (not a callback). The
  // rewritten params with real values are held by the runtime only during the approval
  // wait and never reach the LLM transcript. On deny/timeout the tool call is blocked
  // and the values are discarded.
  //
  // The try/finally guarantees secretsByHandle.clear() runs on EVERY exit path
  // (success, CardUnavailableError, unexpected throw). The clear-then-null pattern
  // enforces "drop the reference immediately" as an invariant, not happy-path-only.
  let secretsByHandle: Map<string, CredentialFillData> | null = new Map();
  try {
    for (const hid of handleIds) {
      const meta = handleMap.get(hid)!; // checked above
      const data = await opts.manager.retrieveCardSecretsForHook(
        meta.providerId,
        meta.spendRequestId,
      );
      secretsByHandle.set(hid, data);
    }

    // 5. Substitute sentinel values with real card values.
    //    realValue is captured into rewrittenFields (plain strings) before finally runs.
    //    If any sentinel cannot be resolved, return block: true with a clear error
    //    (do not silently substitute an empty string).
    const fieldNames = new Set<string>();
    let resolutionError: string | null = null;
    const rewrittenFields = (
      fields as Array<{ value?: unknown; ref?: string; type?: string; [k: string]: unknown }>
    ).map((f) => {
      if (resolutionError !== null) return f;
      if (!isFillSentinel(f.value)) return f;
      const data = secretsByHandle!.get(f.value.$paymentHandle);
      if (!data) return f; // defense: shouldn't happen
      const resolved = resolveSentinel(data, f.value.field);
      if ("error" in resolved) {
        resolutionError = resolved.error;
        return f;
      }
      fieldNames.add(f.value.field);
      return { ...f, value: resolved.value };
    });

    if (resolutionError !== null) {
      return {
        block: true,
        blockReason: resolutionError,
      };
    }

    // 6. Build approval description (non-secret display only).
    //    Includes alphabetized field-name list so the user sees exactly which
    //    fields are being filled (including any forward-compat extras).
    const description = buildApprovalDescription({
      handleIds,
      sentinelCount: sentinels.length,
      fieldNames: [...fieldNames].sort(),
      targetId: typeof request.targetId === "string" ? request.targetId : undefined,
    });

    // 7. Build rewritten params using structuredClone to deep-clone request, isolating
    //    rewrittenRequest.targetId and any future fields from downstream-hook mutation.
    const rewrittenRequest = structuredClone(request);
    (rewrittenRequest as { fields?: unknown }).fields = rewrittenFields;
    const rewrittenParams = { ...params, request: rewrittenRequest };

    // 8. Return requireApproval + rewritten params together.
    //    The SDK runtime will use `params` as overrideParams only if the user approves.
    //    Raw card values in rewrittenFields are held in memory for at most the approval
    //    timeout duration and are never serialized to the LLM transcript.
    return {
      requireApproval: {
        severity: "critical",
        title: "Payment fill: substitute card values",
        description,
        timeoutBehavior: "deny",
      },
      params: rewrittenParams,
    };
  } catch (err) {
    if (err instanceof CardUnavailableError) {
      return {
        block: true,
        blockReason: `payment fill: card no longer available. Issue a new spend request. (${err.message})`,
      };
    }
    throw err;
  } finally {
    secretsByHandle?.clear();
    secretsByHandle = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves a sentinel `field` name against the credential's CredentialFillData
 * via a 3-tier lookup. Returns `{ value }` on hit or `{ error }` on miss.
 *
 * Tier 1 — card secrets (closed, type-safe switch).
 * Tier 2 — known buyer-profile fields (closed, type-safe checks). Treats
 *          `undefined` profile values as misses so the resolver can describe
 *          available fields rather than substituting empty strings.
 * Tier 3 — forward-compat passthrough via `profile.extras`.
 *
 * On miss, the error includes the list of fields available for THIS credential
 * (the agent may have requested an unknown field or a field the provider didn't
 * populate for this card).
 */
function resolveSentinel(
  data: CredentialFillData,
  field: string,
): { value: string } | { error: string } {
  // Tier 1: card secrets
  switch (field) {
    case "pan":
      return { value: data.secrets.pan };
    case "cvv":
      return { value: data.secrets.cvv };
    case "exp_month":
      return { value: data.secrets.expMonth };
    case "exp_year":
      return { value: data.secrets.expYear };
    case "exp_mm_yy":
      return { value: data.secrets.expMmYy };
    case "exp_mm_yyyy":
      return { value: data.secrets.expMmYyyy };
  }

  // Tier 2: known buyer-profile fields
  if (field === "holder_name" && data.profile.holderName !== undefined) {
    return { value: data.profile.holderName };
  }
  if (data.profile.billing) {
    const b = data.profile.billing;
    if (field === "billing_line1" && b.line1 !== undefined) return { value: b.line1 };
    if (field === "billing_city" && b.city !== undefined) return { value: b.city };
    if (field === "billing_state" && b.state !== undefined) return { value: b.state };
    if (field === "billing_postal_code" && b.postalCode !== undefined) {
      return { value: b.postalCode };
    }
    if (field === "billing_country" && b.country !== undefined) return { value: b.country };
  }

  // Tier 3: forward-compat extras
  if (Object.prototype.hasOwnProperty.call(data.profile.extras, field)) {
    return { value: data.profile.extras[field]! };
  }

  return {
    error: `payment fill: field "${field}" is not available for this credential. Available fields: ${describeAvailableFields(data)}`,
  };
}

/**
 * Returns a comma-separated, alphabetized list of field names that ARE available
 * for the given CredentialFillData. Used for the "field not available" error
 * message so the agent can recover by selecting a valid field.
 */
function describeAvailableFields(data: CredentialFillData): string {
  const fields: string[] = [];
  // Tier 1 is always available (closed shape, all fields populated by adapters).
  fields.push("pan", "cvv", "exp_month", "exp_year", "exp_mm_yy", "exp_mm_yyyy");
  // Tier 2 — only include if the value is defined for this credential.
  if (data.profile.holderName !== undefined) fields.push("holder_name");
  if (data.profile.billing?.line1 !== undefined) fields.push("billing_line1");
  if (data.profile.billing?.city !== undefined) fields.push("billing_city");
  if (data.profile.billing?.state !== undefined) fields.push("billing_state");
  if (data.profile.billing?.postalCode !== undefined) fields.push("billing_postal_code");
  if (data.profile.billing?.country !== undefined) fields.push("billing_country");
  // Tier 3 — forward-compat extras the provider populated.
  fields.push(...Object.keys(data.profile.extras));
  return [...new Set(fields)].sort().join(", ");
}

function buildApprovalDescription(args: {
  handleIds: string[];
  sentinelCount: number;
  fieldNames: string[];
  targetId?: string;
}): string {
  // Look up display info from handleMap — non-secret data only.
  // MUST NOT include: real PAN, CVV, holder name, or full expiry digits.
  const cardSummaries = args.handleIds.map((hid) => {
    const meta = handleMap.get(hid);
    if (!meta) return `unknown(${hid})`;
    const last4Display = meta.last4 ? `••${meta.last4}` : "card";
    return meta.targetMerchantName ? `${last4Display} (${meta.targetMerchantName})` : last4Display;
  });
  const targetDisplay = args.targetId ?? "the open browser tab";
  // Field NAMES (not values) — the user needs to see what's being filled. Field
  // names are non-secret. Values are not included anywhere in the description.
  const fieldsDisplay = args.fieldNames.length > 0 ? args.fieldNames.join(", ") : "(no fields)";
  return (
    `Substitute card values into ${args.sentinelCount} field(s) on ${targetDisplay}. ` +
    `Cards: ${cardSummaries.join(", ")}. ` +
    `Fields: ${fieldsDisplay}. ` +
    `The model will not see the values.`
  );
}
