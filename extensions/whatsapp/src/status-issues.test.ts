import type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import { buildRuntimeAccountStatusSnapshot } from "openclaw/plugin-sdk/status-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectWhatsAppStatusIssues } from "./status-issues.js";

const relink = "Run: openclaw channels login (scan QR on the gateway host).";
const repair =
  "Run: openclaw doctor (or restart the gateway). If it persists, relink via channels login and check logs.";
const issue = (
  kind: ChannelStatusIssue["kind"],
  message: string,
  fix = repair,
  accountId = "default",
) => ({ channel: "whatsapp", accountId, kind, message, fix });
function expectIssues(
  account: Partial<ChannelAccountSnapshot>,
  ...expected: ReturnType<typeof issue>[]
) {
  expect(
    collectWhatsAppStatusIssues([{ accountId: "default", enabled: true, ...account }]),
  ).toEqual(expected);
}

describe("collectWhatsAppStatusIssues", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");
    vi.stubEnv("OPENCLAW_PROFILE", "");
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    {
      name: "logged-out",
      runtime: {
        running: false,
        connected: false,
        linked: false,
        healthState: "logged-out",
        lastError: "status=401",
      },
      expected: issue("auth", "Session logged out: status=401", relink),
    },
    {
      name: "conflict",
      runtime: {
        running: false,
        connected: false,
        linked: true,
        reconnectAttempts: 2,
        healthState: "conflict",
        lastError: "status=440",
      },
      expected: issue("runtime", "Linked but session conflict (reconnectAttempts=2): status=440"),
    },
  ])("preserves projected $name guidance", ({ runtime, expected }) => {
    expectIssues(
      { ...buildRuntimeAccountStatusSnapshot({ runtime }), accountId: "default" },
      expected,
    );
  });

  it.each([
    {
      name: "unstable auth with a reconnecting runtime",
      account: {
        statusState: "unstable",
        linked: true,
        running: true,
        connected: false,
        reconnectAttempts: 2,
        healthState: "reconnecting",
        lastError: "socket closed",
      },
      authMessage: "Auth state is still stabilizing.",
      authFix:
        "Wait a moment for queued credential writes to finish, then retry the command or rerun health.",
      runtimeMessage: "Linked but reconnecting (reconnectAttempts=2): socket closed",
    },
    {
      name: "unlinked auth with a stopped runtime",
      account: {
        linked: false,
        running: true,
        connected: false,
        reconnectAttempts: 1,
        healthState: "stopped",
        lastError: "socket closed",
      },
      authMessage: "Not linked (no WhatsApp Web session).",
      authFix: relink,
      runtimeMessage: "stopped (reconnectAttempts=1): socket closed",
    },
  ])(
    "reports runtime issues alongside $name",
    ({ account, authMessage, authFix, runtimeMessage }) => {
      expectIssues(account, issue("auth", authMessage, authFix), issue("runtime", runtimeMessage));
    },
  );

  it("reports linked but disconnected runtime state", () => {
    expectIssues(
      {
        accountId: "work",
        linked: true,
        running: true,
        connected: false,
        reconnectAttempts: 2,
        lastError: "socket closed",
      },
      issue(
        "runtime",
        "Linked but disconnected (reconnectAttempts=2): socket closed",
        repair,
        "work",
      ),
    );
  });

  it("reports linked but stale runtime state even while connected", () => {
    expectIssues(
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

  it("reports recently reconnected accounts even when the socket is currently healthy", () => {
    expectIssues(
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
});
