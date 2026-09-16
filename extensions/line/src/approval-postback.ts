// Line plugin module owns the postback encoding for approval decision controls.
import { createHmac } from "node:crypto";
import { isImplicitSameChatApprovalAuthorization } from "openclaw/plugin-sdk/approval-auth-runtime";
import { buildApprovalResolutionRef } from "openclaw/plugin-sdk/approval-reference-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";
import type { MessagePresentationAction } from "openclaw/plugin-sdk/interactive-runtime";
import { createSubsystemLogger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { LINE_ACTION_DATA_LIMIT } from "./actions.js";
import { authorizeLineApprovalActor } from "./approval-native.js";
import type { ResolvedLineAccount } from "./types.js";

type LineApprovalPostback = Extract<MessagePresentationAction, { type: "approval" }>;

const APPROVAL_PARAM = "line.approval";
const APPROVAL_KIND_PARAM = "line.approvalKind";
const DECISION_PARAM = "line.decision";
// Both params always carry `=`, so the marker cannot collide with the kind param.
const APPROVAL_MARKER = `${APPROVAL_PARAM}=`;

// The send-time action validator replaces over-limit postback data with an
// "Unavailable" action, which would take the decision off the card, so the reference
// has to fit before it reaches that validator. LINE counts this field in UTF-16 units.
function fitsLinePostbackData(data: string): boolean {
  return data.length <= LINE_ACTION_DATA_LIMIT;
}

const SIGNATURE_PARAM = "line.sig";
// 22 base64url characters carry 132 bits of the HMAC.
const SIGNATURE_LENGTH = 22;
// Typed `/approve` decides only exec and plugin approvals.
const UNVERIFIED_APPROVAL_TAP_NOTICE =
  "Nothing was decided: this approval button could not be verified. Use the Control UI, or for an exec or plugin approval reply /approve with the approval ID shown on the card and your decision.";

// Postback data is not specific to the control that sent it, so a decision counts only
// when its data carries a tag made with the account's channel secret, which only the card
// builder holds. The key is derived under a fixed label, as Mattermost does for its
// interaction tokens, so the tag never reuses the webhook signature key.
function signLineApprovalFields(fields: string, channelSecret: string): string {
  const key = createHmac("sha256", "openclaw-line-approval-postback")
    .update(channelSecret)
    .digest();
  return createHmac("sha256", key).update(fields).digest("base64url").slice(0, SIGNATURE_LENGTH);
}

function encodeLineApprovalFields(fields: {
  approvalRef: string;
  approvalKind: LineApprovalPostback["approvalKind"];
  decision: LineApprovalPostback["decision"];
}): string {
  return new URLSearchParams({
    [APPROVAL_PARAM]: fields.approvalRef,
    [APPROVAL_KIND_PARAM]: fields.approvalKind,
    [DECISION_PARAM]: fields.decision,
  }).toString();
}

function encodeLineApprovalPostbackData(
  action: LineApprovalPostback,
  approvalRef: string,
  channelSecret: string,
): string {
  const fields = encodeLineApprovalFields({
    approvalRef,
    approvalKind: action.approvalKind,
    decision: action.decision,
  });
  return `${fields}&${SIGNATURE_PARAM}=${signLineApprovalFields(fields, channelSecret)}`;
}

/** Reserve the approval namespace even for postback data this module cannot read. */
export function hasLineApprovalPostbackData(data?: string | null): boolean {
  return data?.includes(APPROVAL_MARKER) === true;
}

/** Encode one approval decision into LINE postback data, tagged for this account. */
export function buildLineApprovalPostbackData(
  action: LineApprovalPostback,
  channelSecret: string,
): string | undefined {
  const approvalId = normalizeOptionalString(action.approvalId);
  // Without a secret the tag is one anyone can compute and the tap refuses it, so the
  // card is not drawn and the approver gets the command text instead.
  if (!approvalId || !channelSecret) {
    return undefined;
  }
  const exact = encodeLineApprovalPostbackData(action, approvalId, channelSecret);
  if (fitsLinePostbackData(exact)) {
    return exact;
  }
  // Approval ids carry no length ceiling. A digest locator keeps the control
  // tappable instead of dropping it; Gateway authorization still guards the
  // canonical record this resolves to.
  const ref = encodeLineApprovalPostbackData(
    action,
    buildApprovalResolutionRef({ approvalId, approvalKind: action.approvalKind }),
    channelSecret,
  );
  return fitsLinePostbackData(ref) ? ref : undefined;
}

/** Read an approval decision back out of postback data a card for this account built. */
function parseLineApprovalPostbackData(
  data: string,
  channelSecret: string,
): LineApprovalPostback | undefined {
  if (!hasLineApprovalPostbackData(data)) {
    return undefined;
  }
  const params = new URLSearchParams(data);
  const approvalId = normalizeOptionalString(params.get(APPROVAL_PARAM));
  const approvalKind = normalizeOptionalString(params.get(APPROVAL_KIND_PARAM));
  const decision = normalizeOptionalString(params.get(DECISION_PARAM));
  if (
    !approvalId ||
    (approvalKind !== "exec" && approvalKind !== "plugin" && approvalKind !== "system-agent") ||
    (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny") ||
    // An empty secret yields a tag anyone can compute.
    !channelSecret
  ) {
    return undefined;
  }
  // The tag is checked against the fields exactly as decided below, re-encoded, so
  // accepted data always decides the fields that were signed.
  const expected = signLineApprovalFields(
    encodeLineApprovalFields({ approvalRef: approvalId, approvalKind, decision }),
    channelSecret,
  );
  if (!safeEqualSecret(params.get(SIGNATURE_PARAM), expected)) {
    return undefined;
  }
  return { type: "approval", approvalId, approvalKind, decision };
}

/**
 * Record the decision a LINE tap carried, and return only what the approver must be told.
 *
 * A recorded decision stays silent: LINE echoes the chosen label through the action's
 * `displayText`, and the approval runtime publishes the outcome as its own message. A tap
 * that changes nothing, because the approval was already decided or is gone, says so.
 * Unreadable data, including data no card for this account built, decides nothing and
 * returns a fixed notice that repeats none of that data.
 */
export async function resolveLineApprovalPostbackTap(params: {
  /** The config current when called; read after awaited work, just before the decision. */
  resolveConfig: () => OpenClawConfig;
  /** The account whose webhook carried this tap; its secret verified that webhook. */
  account: Pick<ResolvedLineAccount, "accountId" | "channelSecret">;
  data: string;
  senderId?: string;
}): Promise<string | undefined> {
  const callback = parseLineApprovalPostbackData(params.data, params.account.channelSecret);
  if (!callback) {
    // A card sent before the channel secret changed lands here too, and pending approvals
    // are not sent again as new cards, so the approver needs another way to decide.
    // Created at the call, not at module evaluation, so consumers that partially mock the
    // runtime-env module can still load this one.
    createSubsystemLogger("line/approvals").warn(
      `[${params.account.accountId}] ignored approval postback data that no approval card for this account built`,
    );
    return UNVERIFIED_APPROVAL_TAP_NOTICE;
  }
  // Typed `/approve` decides only exec and plugin approvals, so an OpenClaw-change
  // approval that a tap cannot decide is sent to the Control UI instead.
  const typedCommand =
    callback.approvalKind === "system-agent"
      ? undefined
      : `/approve ${callback.approvalId} ${callback.decision}`;
  const commandFallback = typedCommand
    ? `Reply ${typedCommand} to decide this approval.`
    : "Decide this approval from the Control UI.";
  const senderId = params.senderId;
  if (!senderId) {
    // A tap without a sender could not name who decided.
    return commandFallback;
  }
  try {
    const { resolveApprovalOverGateway } =
      await import("openclaw/plugin-sdk/approval-gateway-runtime");
    // Authority is checked against the config current now, after the import, so an
    // approver removed while the event waited cannot still decide.
    const cfg = params.resolveConfig();
    const authorization = authorizeLineApprovalActor({
      cfg,
      accountId: params.account.accountId,
      senderId,
      action: "approve",
      approvalKind: callback.approvalKind,
    });
    if (isImplicitSameChatApprovalAuthorization(authorization)) {
      // Same-chat authorization defers to command authorization, which a tap never passes
      // through; typed `/approve` does.
      return commandFallback;
    }
    if (!authorization.authorized) {
      // The approver allowlist owns this wording; it is written to be shown.
      return authorization.reason;
    }
    // Reviewer identity is all-or-nothing for the gateway, and it is what binds the
    // resolution to this LINE account's approver custody. It also names the sender in
    // the published outcome, so no display name overrides it.
    const result = await resolveApprovalOverGateway({
      cfg,
      approvalId: callback.approvalId,
      approvalKind: callback.approvalKind,
      decision: callback.decision,
      channel: "line",
      accountId: params.account.accountId,
      senderId,
    });
    if (!result || result.applied) {
      return undefined;
    }
    // A tap that raced the first decision changes nothing; the loser hears what stands.
    const { approval } = result;
    const { formatApprovalDecisionLabel } = await import("openclaw/plugin-sdk/approval-runtime");
    const outcome =
      approval.status === "allowed"
        ? formatApprovalDecisionLabel(approval.decision)
        : approval.status === "denied"
          ? "Denied"
          : approval.status === "expired"
            ? "Expired"
            : "Cancelled";
    return `This approval was already resolved: ${outcome}.`;
  } catch (error) {
    logVerbose(`line: approval decision could not be recorded: ${String(error)}`);
    if (isApprovalNotFoundError(error)) {
      // A resolved approval leaves the pending set within moments, and LINE keeps its
      // buttons forever, so this is the usual late tap. `/approve` would fail the same
      // way, and resolved, expired and restarted-away requests look identical here.
      return "That approval is no longer waiting for a decision.";
    }
    // The tap is the approver's only signal that anything happened; a swallowed
    // failure would leave the decision looking recorded while the run still waits.
    // True whether the request is still pending or was already decided elsewhere: the
    // command answers authoritatively either way, so the notice claims neither.
    return typedCommand
      ? `Could not record that decision. Reply ${typedCommand} instead.`
      : "Could not record that decision. Decide it from the Control UI instead.";
  }
}
