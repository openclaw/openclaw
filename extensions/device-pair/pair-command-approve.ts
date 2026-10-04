// Device Pair plugin module implements pair command approve behavior.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  approveDevicePairing,
  listDevicePairing,
  resolveDevicePairingApprovalDenial,
} from "./api.js";
import { formatPendingRequests } from "./notify.js";

type PendingPairingEntry = Awaited<ReturnType<typeof listDevicePairing>>["pending"][number];
type ApprovePairingResult = Awaited<ReturnType<typeof approveDevicePairing>>;
type ApprovedPairingEntry = Exclude<ApprovePairingResult, null | { status: "forbidden" }>;

function buildMultiplePendingApprovalReply(pending: PendingPairingEntry[]): { text: string } {
  return {
    text:
      `${formatPendingRequests(pending)}\n\n` +
      "Multiple pending requests found. Approve one explicitly:\n" +
      "/pair approve <requestId>\n" +
      "Or approve the most recent:\n" +
      "/pair approve latest",
  };
}

export function selectPendingApprovalRequest(params: {
  pending: PendingPairingEntry[];
  requested?: string;
}): { pending?: PendingPairingEntry; reply?: { text: string } } {
  const [firstPending, ...remainingPending] = params.pending;
  if (!firstPending) {
    return { reply: { text: "No pending device pairing requests." } };
  }

  if (!params.requested) {
    return remainingPending.length === 0
      ? { pending: firstPending }
      : { reply: buildMultiplePendingApprovalReply(params.pending) };
  }

  if (normalizeLowercaseStringOrEmpty(params.requested) === "latest") {
    let latest = firstPending;
    for (const pending of remainingPending) {
      if ((pending.ts ?? 0) > (latest.ts ?? 0)) {
        latest = pending;
      }
    }
    return { pending: latest };
  }

  return {
    pending: params.pending.find((entry) => entry.requestId === params.requested),
    reply: undefined,
  };
}

function formatApprovedPairingReply(approved: ApprovedPairingEntry): { text: string } {
  const label = normalizeOptionalString(approved.device.displayName) || approved.device.deviceId;
  const platform = normalizeOptionalString(approved.device.platform);
  const platformLabel = platform ? ` (${platform})` : "";
  return { text: `✅ Paired ${label}${platformLabel}.` };
}

export async function approvePendingPairingRequest(params: {
  pending: PendingPairingEntry;
  callerScopes?: readonly string[];
  assertCurrent?: () => void;
}): Promise<{ text: string }> {
  const denial = resolveDevicePairingApprovalDenial(
    {
      callerDeviceId: null,
      isAdminCaller: params.callerScopes?.includes("operator.admin") === true,
    },
    params.pending,
  );
  if (denial) {
    return { text: "⚠️ This command requires operator.admin to approve this pairing request." };
  }
  const requestId = params.pending.requestId;
  const assertCurrent = params.assertCurrent;
  const isApprovalCurrent = assertCurrent
    ? () => {
        assertCurrent();
        return true;
      }
    : undefined;
  const approved =
    params.callerScopes === undefined && !isApprovalCurrent
      ? await approveDevicePairing(requestId)
      : await approveDevicePairing(requestId, {
          callerScopes: params.callerScopes,
          ...(isApprovalCurrent ? { isApprovalCurrent } : {}),
        });
  if (!approved) {
    return { text: "Pairing request not found." };
  }
  if (approved.status === "forbidden") {
    return {
      text: `⚠️ This command requires ${approved.scope ?? approved.role ?? "additional approval"} to approve this pairing request.`,
    };
  }
  return formatApprovedPairingReply(approved);
}
