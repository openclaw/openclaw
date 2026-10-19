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
const issue = (kind: ChannelStatusIssue["kind"], message: string, fix = repair) => ({
  kind,
  message,
  fix,
});
const account = (overrides: Partial<ChannelAccountSnapshot>) => ({
  accountId: "default",
  enabled: true,
  linked: true,
  running: true,
  connected: false,
  ...overrides,
});
function expectIssues(
  input: Partial<ChannelAccountSnapshot>,
  expected: ReturnType<typeof issue>[],
) {
  const snapshot = { accountId: "default", enabled: true, ...input };
  expect(collectWhatsAppStatusIssues([snapshot])).toEqual(
    expected.map((entry) => ({ channel: "whatsapp", accountId: snapshot.accountId, ...entry })),
  );
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
    expectIssues({ ...buildRuntimeAccountStatusSnapshot({ runtime }), accountId: "default" }, [
      expected,
    ]);
  });

  it.each([
    {
      name: "unstable auth alongside a reconnecting runtime",
      input: account({
        statusState: "unstable",
        reconnectAttempts: 2,
        healthState: "reconnecting",
        lastError: "socket closed",
      }),
      expected: [
        issue(
          "auth",
          "Auth state is still stabilizing.",
          "Wait a moment for queued credential writes to finish, then retry the command or rerun health.",
        ),
        issue("runtime", "Linked but reconnecting (reconnectAttempts=2): socket closed"),
      ],
    },
    {
      name: "unlinked auth alongside a stopped runtime",
      input: account({
        linked: false,
        reconnectAttempts: 1,
        healthState: "stopped",
        lastError: "socket closed",
      }),
      expected: [
        issue("auth", "Not linked (no WhatsApp Web session).", relink),
        issue("runtime", "stopped (reconnectAttempts=1): socket closed"),
      ],
    },
    {
      name: "linked but disconnected runtime state",
      input: account({ accountId: "work", reconnectAttempts: 2, lastError: "socket closed" }),
      expected: [issue("runtime", "Linked but disconnected (reconnectAttempts=2): socket closed")],
    },
    {
      name: "stale runtime state even while connected",
      input: () =>
        account({ connected: true, healthState: "stale", lastInboundAt: Date.now() - 2 * 60_000 }),
      expected: [issue("runtime", "Linked but stale (last inbound 2m ago).")],
    },
    {
      name: "recently reconnected accounts with a healthy socket",
      input: () =>
        account({
          connected: true,
          reconnectAttempts: 3,
          healthState: "healthy",
          lastDisconnect: {
            at: Date.now() - 2 * 60_000,
            status: 408,
            error: "status=408 Request Time-out Connection was lost",
          },
        }),
      expected: [
        issue(
          "runtime",
          "Linked but recently reconnected (reconnectAttempts=3): status=408 Request Time-out Connection was lost",
          "Watch: openclaw logs --follow and run openclaw channels status --probe if disconnects continue. If it keeps flapping, restart the gateway or relink via channels login.",
        ),
      ],
    },
  ])("reports $name", ({ input, expected }) => {
    expectIssues(typeof input === "function" ? input() : input, expected);
  });
});
