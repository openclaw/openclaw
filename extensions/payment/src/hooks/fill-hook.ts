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
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PaymentManager } from "../payments.js";
import { CardUnavailableError } from "../providers/base.js";
import type { CardSecrets } from "../providers/base.js";
import { handleMap } from "../store.js";
import { findSentinelsInFields, isFillSentinel } from "./sentinel.js";
import type { FillSentinelField } from "./sentinel.js";

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
  let secretsByHandle = new Map<string, CardSecrets>();
  try {
    for (const hid of handleIds) {
      const meta = handleMap.get(hid)!; // checked above
      const secrets = await opts.manager.retrieveCardSecretsForHook(
        meta.providerId,
        meta.spendRequestId,
      );
      secretsByHandle.set(hid, secrets);
    }
  } catch (err) {
    if (err instanceof CardUnavailableError) {
      return {
        block: true,
        blockReason: `payment fill: card no longer available. Issue a new spend request. (${err.message})`,
      };
    }
    throw err;
  }

  // 5. Substitute sentinel values with real card values
  const rewrittenFields = (
    fields as Array<{ value?: unknown; ref?: string; type?: string; [k: string]: unknown }>
  ).map((f) => {
    if (!isFillSentinel(f.value)) return f;
    const secrets = secretsByHandle.get(f.value.$paymentHandle);
    if (!secrets) return f; // defense: shouldn't happen
    const realValue = pickSecretValue(secrets, f.value.field as FillSentinelField);
    return { ...f, value: realValue };
  });

  // 6. Drop local secret references immediately after substitution
  secretsByHandle.clear();
  secretsByHandle = null as unknown as Map<string, CardSecrets>;

  // 7. Build approval description (non-secret display only)
  const description = buildApprovalDescription({
    handleIds,
    sentinelCount: sentinels.length,
    targetId: typeof request.targetId === "string" ? request.targetId : undefined,
  });

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
    params: {
      ...params,
      request: { ...request, fields: rewrittenFields },
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickSecretValue(secrets: CardSecrets, field: FillSentinelField): string {
  switch (field) {
    case "pan":
      return secrets.pan;
    case "cvv":
      return secrets.cvv;
    case "exp_month":
      return secrets.expMonth;
    case "exp_year":
      return secrets.expYear;
    case "holder_name":
      return secrets.holderName;
  }
}

function buildApprovalDescription(args: {
  handleIds: string[];
  sentinelCount: number;
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
  return (
    `Substitute card values into ${args.sentinelCount} field(s) on ${targetDisplay}. ` +
    `Cards: ${cardSummaries.join(", ")}. ` +
    `The model will not see the values.`
  );
}
