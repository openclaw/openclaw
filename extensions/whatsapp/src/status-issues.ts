import type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import {
  collectIssuesForEnabledAccounts,
  isRecord,
  readAccountStatusSnapshot,
} from "openclaw/plugin-sdk/status-helpers";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const WHATSAPP_ACCOUNT_STATUS_FIELDS = [
  "statusState",
  "linked",
  "reconnectAttempts",
  "lastDisconnect",
  "lastInboundAt",
  "lastError",
  "healthState",
] as const;

const RECENT_DISCONNECT_WARNING_WINDOW_MS = 15 * 60 * 1000;

function readLastDisconnect(value: unknown): { at: number | null; error?: string } | null {
  if (typeof value === "string") {
    const error = normalizeOptionalString(value);
    return error ? { at: null, error } : null;
  }
  if (!isRecord(value)) {
    return null;
  }
  return {
    at: typeof value.at === "number" ? value.at : null,
    error: normalizeOptionalString(value.error),
  };
}

function isRecentDisconnect(disconnect: { at: number | null } | null, now = Date.now()): boolean {
  if (disconnect?.at == null) {
    return false;
  }
  return now - disconnect.at <= RECENT_DISCONNECT_WARNING_WINDOW_MS;
}

export function collectWhatsAppStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  return collectIssuesForEnabledAccounts({
    accounts,
    readAccount: (value) => readAccountStatusSnapshot(value, WHATSAPP_ACCOUNT_STATUS_FIELDS),
    collectIssues: ({ account, accountId, issues }) => {
      const linked = account.linked === true;
      const statusState = normalizeOptionalString(account.statusState);
      const running = account.running === true;
      const connected = account.connected === true;
      const reconnectAttempts =
        typeof account.reconnectAttempts === "number" ? account.reconnectAttempts : null;
      const lastInboundAt =
        typeof account.lastInboundAt === "number" ? account.lastInboundAt : null;
      const lastDisconnect = readLastDisconnect(account.lastDisconnect);
      const lastError = normalizeOptionalString(account.lastError) ?? lastDisconnect?.error;
      const healthState = normalizeOptionalString(account.healthState);
      const addIssue = (kind: ChannelStatusIssue["kind"], message: string, fix: string) => {
        issues.push({ channel: "whatsapp", accountId, kind, message, fix });
      };
      const relink = `Run: ${formatCliCommand("openclaw channels login")} (scan QR on the gateway host).`;
      const repair = `Run: ${formatCliCommand("openclaw doctor")} (or restart the gateway). If it persists, relink via channels login and check logs.`;

      if (statusState === "unstable") {
        addIssue(
          "auth",
          "Auth state is still stabilizing.",
          "Wait a moment for queued credential writes to finish, then retry the command or rerun health.",
        );
        return;
      }

      if (healthState === "logged-out") {
        addIssue("auth", `Session logged out${lastError ? `: ${lastError}` : "."}`, relink);
        return;
      }

      if (!linked) {
        addIssue("auth", "Not linked (no WhatsApp Web session).", relink);
        return;
      }

      if (healthState === "stale") {
        const staleSuffix =
          lastInboundAt != null
            ? ` (last inbound ${Math.max(0, Math.floor((Date.now() - lastInboundAt) / 60000))}m ago)`
            : "";
        addIssue(
          "runtime",
          `Linked but stale${staleSuffix}${lastError ? `: ${lastError}` : "."}`,
          repair,
        );
        return;
      }

      if (
        healthState === "reconnecting" ||
        healthState === "conflict" ||
        healthState === "stopped"
      ) {
        const stateLabel =
          healthState === "conflict"
            ? "session conflict"
            : healthState === "reconnecting"
              ? "reconnecting"
              : "stopped";
        addIssue(
          "runtime",
          `Linked but ${stateLabel}${reconnectAttempts != null ? ` (reconnectAttempts=${reconnectAttempts})` : ""}${lastError ? `: ${lastError}` : "."}`,
          repair,
        );
        return;
      }

      if (
        running &&
        connected &&
        reconnectAttempts != null &&
        reconnectAttempts > 0 &&
        isRecentDisconnect(lastDisconnect)
      ) {
        addIssue(
          "runtime",
          `Linked but recently reconnected (reconnectAttempts=${reconnectAttempts})${lastError ? `: ${lastError}` : "."}`,
          `Watch: ${formatCliCommand("openclaw logs --follow")} and run ${formatCliCommand("openclaw channels status --probe")} if disconnects continue. If it keeps flapping, restart the gateway or relink via channels login.`,
        );
        return;
      }

      if (running && !connected) {
        addIssue(
          "runtime",
          `Linked but disconnected${reconnectAttempts != null ? ` (reconnectAttempts=${reconnectAttempts})` : ""}${lastError ? `: ${lastError}` : "."}`,
          repair,
        );
      }
    },
  });
}
