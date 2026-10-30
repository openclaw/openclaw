import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { slackConversationRouteOwners } from "./conversation-route-owner.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";

const defaultSlack = { accounts: { default: {} } };
const unbound = { status: "available" as const, binding: null };
async function inspect(
  peerId = "C456",
  slack: NonNullable<OpenClawConfig["channels"]>["slack"] = defaultSlack,
  accountId = "default",
) {
  const input = {
    cfg: { channels: { slack } },
    accountId,
    conversation: { kind: "channel" as const, peerId },
  };
  const [resolve] = await slackConversationRouteOwners.prepareConversationRouteOwnersAsync(
    [input],
    async (refs) => () => refs.map(() => unbound),
  );
  return resolve!();
}

let installation: ReturnType<typeof registerSlackInstallationState>;

beforeEach(() => {
  for (const key of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_USER_TOKEN"]) {
    vi.stubEnv(key, undefined);
  }
  installation = registerSlackInstallationState("default", "workspace");
});

afterEach(() => {
  installation.release();
  vi.unstubAllEnvs();
});

it("distinguishes degraded identity from a qualified target conflict", async () => {
  installation.update("degraded");
  expect(await inspect()).toEqual({ kind: "unavailable" });
  installation.update("workspace");
  expect(await inspect("team:T123:channel:C456")).toBeNull();
});

it("fails closed when workspace identity is released during binding inspection", async () => {
  expect(await inspect()).toEqual({ kind: "agent", agentId: "main" });
  installation.release();
  expect(await inspect()).toEqual({ kind: "unavailable" });
});
it.each([
  ["removed account", "retired", { accounts: { default: {} } }],
  ["removed default account", "default", { accounts: {} }],
  ["disabled account", "default", { accounts: { default: { enabled: false } } }],
  ["disabled channel", "default", { enabled: false, accounts: { default: { enabled: true } } }],
] as const)("rejects inactive %s without identity", async (_name, accountId, slack) => {
  installation.release();

  expect(await inspect("C456", slack, accountId)).toBeNull();
});

it("preserves a configured default while its token and installation are unavailable", async () => {
  vi.stubEnv("OPENCLAW_TEST_MISSING_SLACK_BOT_TOKEN", undefined);
  installation.release();
  expect(
    await inspect("C456", {
      botToken: {
        source: "env",
        provider: "default",
        id: "OPENCLAW_TEST_MISSING_SLACK_BOT_TOKEN",
      },
      appToken: "synthetic-app-token",
      accounts: { secondary: {} },
    }),
  ).toEqual({ kind: "unavailable" });
});
