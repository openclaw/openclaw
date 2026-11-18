import type { DiscordConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, expect, it, vi } from "vitest";
import { createDiscordClient, createDiscordRestClient } from "./client.js";
import type { GatewayPlugin } from "./internal/gateway.js";
import type { RequestClient } from "./internal/rest.js";
import { clearGateways, registerGateway } from "./monitor/gateway-registry.js";
import { makeDiscordRest } from "./send.test-harness.js";

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
  clearGateways();
});

function config(discord: DiscordConfig): OpenClawConfig {
  return { channels: { discord } };
}

it("keeps explicit-token retries bound to the REST account", async () => {
  registerGateway("default", { isConnected: false } as GatewayPlugin);
  registerGateway("ops", { isConnected: true } as GatewayPlugin);
  const client = createDiscordClient({
    cfg: config({ defaultAccount: "ops", accounts: { ops: { token: "configured-token" } } }),
    token: "explicit-token",
    rest: {} as RequestClient,
    retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
  });
  const operation = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockResolvedValue("sent");

  expect(client.account.accountId).toBe("ops");
  await expect(client.request(operation, "send")).resolves.toBe("sent");
  expect(operation).toHaveBeenCalledTimes(4);
});
const fakeRest = {} as RequestClient;

it("keeps a resolved account token when a command has only pinned its unresolved config", async () => {
  const token = { source: "env", provider: "default", id: "DISCORD_WORK_TOKEN" } as const;
  const sourceConfig = config({ accounts: { work: { token } } });
  const resolvedConfig = config({ accounts: { work: { token: "Bot resolved-work-token" } } });
  // A pinned source config is not an activated secrets snapshot.
  setRuntimeConfigSnapshot(sourceConfig);

  const { rest, getMock, postMock } = makeDiscordRest();
  getMock.mockResolvedValue({ id: "789", type: 0 });
  postMock.mockResolvedValue({ id: "sent-message", channel_id: "789" });
  const context = { cfg: resolvedConfig, accountId: "work", rest };
  const client = createDiscordRestClient(context);

  expect(client).toMatchObject({ token: "resolved-work-token", account: { accountId: "work" } });
  const { sendMessageDiscord } = await import("./send.js");
  await expect(sendMessageDiscord("channel:789", "hello", context)).resolves.toMatchObject({
    messageId: "sent-message",
    channelId: "789",
  });
  expect(postMock).toHaveBeenCalledOnce();
  expect(() =>
    createDiscordRestClient({ cfg: sourceConfig, accountId: "work", rest: fakeRest }),
  ).toThrow(/configured for account "work" is unavailable/i);
});

it("applies a caller timeout to a dedicated REST client", () => {
  const result = createDiscordRestClient({
    cfg: config({ token: "discord-token" }),
    timeoutMs: 250,
  });
  expect(result.rest.options.timeout).toBe(250);
});

it("still fails closed when no explicit token is provided and config token is unresolved", () => {
  vi.stubEnv("DISCORD_BOT_TOKEN", "env-token");
  const cfg = config({ token: { source: "file", provider: "default", id: "/discord/token" } });

  expect(() => createDiscordRestClient({ cfg, rest: fakeRest })).toThrow(
    /configured for account "default" is unavailable/i,
  );
});
