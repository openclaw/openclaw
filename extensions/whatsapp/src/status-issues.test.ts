import type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import { buildRuntimeAccountStatusSnapshot } from "openclaw/plugin-sdk/status-helpers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { collectWhatsAppStatusIssues } from "./status-issues.js";

const relink = "Run: openclaw channels login (scan QR on the gateway host).";
const repair =
  "Run: openclaw doctor (or restart the gateway). If it persists, relink via channels login and check logs.";
const issue = (kind: ChannelStatusIssue["kind"], message: string, fix = repair) => ({
  kind,
  message,
  fix,
});
const closed = {
  linked: true,
  running: true,
  connected: false,
  reconnectAttempts: 2,
  lastError: "socket closed",
};
function check(input: Partial<ChannelAccountSnapshot>, ...expected: ReturnType<typeof issue>[]) {
  const snapshot = { accountId: "default", enabled: true, ...input };
  expect(collectWhatsAppStatusIssues([snapshot])).toEqual(
    expected.map((entry) =>
      Object.assign({ channel: "whatsapp", accountId: snapshot.accountId }, entry),
    ),
  );
}
beforeEach(() => {
  vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");
  vi.stubEnv("OPENCLAW_PROFILE", "");
});
afterEach(() => vi.unstubAllEnvs());

it.each([
  [false, "logged-out", "status=401", issue("auth", "Session logged out: status=401", relink)],
  [
    true,
    "conflict",
    "status=440",
    issue("runtime", "Linked but session conflict (reconnectAttempts=2): status=440"),
  ],
] as const)("preserves projected %s %s guidance", (linked, healthState, lastError, expected) => {
  const runtime = {
    running: false,
    connected: false,
    linked,
    healthState,
    lastError,
    ...(linked ? { reconnectAttempts: 2 } : {}),
  };
  check({ ...buildRuntimeAccountStatusSnapshot({ runtime }), accountId: "default" }, expected);
});

it("reports unstable auth alongside reconnection", () => {
  check(
    { ...closed, statusState: "unstable", healthState: "reconnecting" },
    issue(
      "auth",
      "Auth state is still stabilizing.",
      "Wait a moment for queued credential writes to finish, then retry the command or rerun health.",
    ),
    issue("runtime", "Linked but reconnecting (reconnectAttempts=2): socket closed"),
  );
});

it("reports unlinked auth alongside a stopped runtime", () => {
  check(
    { ...closed, linked: false, reconnectAttempts: 1, healthState: "stopped" },
    issue("auth", "Not linked (no WhatsApp Web session).", relink),
    issue("runtime", "stopped (reconnectAttempts=1): socket closed"),
  );
});

it("reports linked but disconnected accounts", () => {
  check(
    { ...closed, accountId: "work" },
    issue("runtime", "Linked but disconnected (reconnectAttempts=2): socket closed"),
  );
});

it("reports staleness even while connected", () => {
  check(
    {
      linked: true,
      running: true,
      connected: true,
      healthState: "stale",
      lastInboundAt: Date.now() - 2 * 60_000,
    },
    issue("runtime", "Linked but stale (last inbound 2m ago)."),
  );
});

it("reports a healthy socket that recently reconnected", () => {
  check(
    {
      linked: true,
      running: true,
      connected: true,
      reconnectAttempts: 3,
      healthState: "healthy",
      lastDisconnect: {
        at: Date.now() - 2 * 60_000,
        status: 408,
        error: "status=408 Request Time-out Connection was lost",
      },
    },
    issue(
      "runtime",
      "Linked but recently reconnected (reconnectAttempts=3): status=408 Request Time-out Connection was lost",
      "Watch: openclaw logs --follow and run openclaw channels status --probe if disconnects continue. If it keeps flapping, restart the gateway or relink via channels login.",
    ),
  );
});
