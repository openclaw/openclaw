import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerXAllowlistMethods } from "./admin.js";
import { openXAllowlist } from "./allowlist.js";
import { createXApiClient } from "./api.js";
import {
  client,
  config,
  fixture,
  page,
  post,
  type Payload,
} from "./test-support/monitor-fixture.js";
import { createQueue } from "./test-support/monitor.js";
import { createXTestSpend } from "./test-support/spend.js";

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  getXApi: vi.fn(),
  getXTokenState: () => "ready",
}));

beforeEach(() => {
  vi.useFakeTimers();
  client.getXApi.mockReset();
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
});

const accountsConfig: OpenClawConfig = {
  ...config,
  channels: {
    x: {
      ...config.channels?.x,
      accounts: { default: {}, second: { userId: "101", username: "other_bot" } },
    },
  },
};

async function administrator(test: ReturnType<typeof fixture>) {
  const allowlist = openXAllowlist(test.runtime);
  for (const accountId of ["default", "second"]) {
    await allowlist.put(accountId, {
      userId: "30",
      username: "stored_maintainer",
      name: "Stored",
      addedBy: "operator",
      addedAt: 0,
    });
  }
  type Handler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
  const handlers = new Map<string, Handler>();
  registerXAllowlistMethods({
    runtime: test.runtime,
    logger: test.logger,
    registerGatewayMethod: (name, handler) => {
      handlers.set(name, handler);
    },
  });
  return async (accountId = "default") => {
    const respond = vi.fn();
    await handlers.get("x.allowlist.remove")!({
      req: { type: "req", id: "remove-stored-sender", method: "x.allowlist.remove" },
      isWebchatConnect: () => false,
      params: { userId: "30", accountId },
      respond,
      // This handler only consumes config; the other host services stay outside the fixture.
      context: {
        getRuntimeConfig: () => accountsConfig,
      } as Parameters<Handler>[0]["context"],
      client: {
        connect: {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "ui" },
          scopes: ["operator.admin"],
        },
        connId: "synthetic-admin",
      },
      hasCurrentClientAuthority: () => true,
    });
    expect(respond).toHaveBeenCalledWith(true, expect.anything());
  };
}

describe("X stored allowlist authority", () => {
  it.each(["thread", "binding", "unrelated account"] as const)(
    "settles the mention once after removal during %s admission",
    async (phase) => {
      const completed = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const onCompleted = vi.fn(() => completed.resolve());
      const onReleased = vi.fn(() => released.resolve());
      const queue = createQueue<Payload>({ onCompleted, onReleased });
      const test = fixture({ posts: [post("501", "30")], cfg: accountsConfig, queue });
      const remove = await administrator(test);
      if (phase === "thread") {
        test.api.searchConversation.mockImplementationOnce(async () => {
          entered.resolve();
          await resume.promise;
          return page([post("500", "10", "Original thread")]);
        });
      } else {
        test.resolveStable.mockImplementation(async (params) => {
          const resolved = await resolveStableChannelMessageIngress(params);
          if (params.contextBinding) {
            entered.resolve();
            await resume.promise;
          }
          return resolved;
        });
      }
      const running = test.start();
      try {
        await entered.promise;
        await remove(phase === "unrelated account" ? "second" : "default");
        resume.resolve();
        if (phase === "binding") {
          expect(
            await Promise.race([
              released.promise.then(() => "released"),
              completed.promise.then(() => "completed"),
            ]),
          ).toBe("released");
          expect(test.dispatch).not.toHaveBeenCalled();
          expect(await queue.listPending()).toMatchObject([
            { lastError: "X allowlist changed during authorization; retrying with current policy" },
          ]);
          await vi.advanceTimersByTimeAsync(1_000);
        }
        await completed.promise;
        // Offer the same mention on another poll and let pending retries run.
        await vi.advanceTimersByTimeAsync(60_000);
        const allowed = phase === "unrelated account";
        expect(running.status()).toMatchObject({ droppedMentions: allowed ? 0 : 1 });
        expect(test.dispatch).toHaveBeenCalledTimes(allowed ? 1 : 0);
        expect(test.replies).toHaveLength(allowed ? 1 : 0);
        expect(onCompleted).toHaveBeenCalledExactlyOnceWith("501");
        expect(onReleased).toHaveBeenCalledTimes(phase === "binding" ? 1 : 0);
        expect(await queue.listPending()).toEqual([]);
        expect(await queue.listClaims()).toEqual([]);
        expect(test.api.searchConversation).toHaveBeenCalledOnce();
        expect(test.api.getMentions.mock.calls.length).toBeGreaterThan(1);
      } finally {
        resume.resolve();
        await test.stop();
      }
    },
  );

  it.each([
    { removedAccount: "default", phase: "resolution" },
    { removedAccount: "default", phase: "fetch handoff" },
    { removedAccount: "second", phase: "resolution" },
  ])(
    "rechecks a $removedAccount account removal during reply $phase after dispatch",
    async ({ removedAccount, phase }) => {
      const test = fixture({ posts: [post("501", "30")], cfg: accountsConfig });
      const remove = await administrator(test);
      let posts = 0;
      const api = createXApiClient({
        spend: createXTestSpend(),
        clientId: "synthetic-client",
        clientSecret: "synthetic-secret",
        refreshToken: "synthetic-refresh",
        saveRefreshToken: async () => {},
        fetch: async (url, init) => {
          if (url.endsWith("/oauth2/token")) {
            return Response.json({ access_token: "synthetic-access" });
          }
          expect(url).toBe("https://api.x.com/2/tweets");
          expect(init?.method).toBe("POST");
          posts++;
          return Response.json({ data: { id: "901" } });
        },
      });
      const settled = Promise.withResolvers<unknown>();
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      test.api.reply.mockImplementation((params) => {
        const reply = api.reply({
          ...params,
          assertActive: async () => {
            const assertCurrent = await params.assertActive?.();
            if (phase === "fetch handoff") {
              entered.resolve();
              await resume.promise;
            }
            return assertCurrent;
          },
        });
        void reply.then(settled.resolve, settled.resolve);
        return reply;
      });
      test.resolveStable.mockImplementation(async (params) => {
        const resolved = await resolveStableChannelMessageIngress(params);
        if (phase === "resolution" && test.dispatch.mock.calls.length) {
          entered.resolve();
          await resume.promise;
        }
        return resolved;
      });
      test.start();
      try {
        await entered.promise;
        expect(test.dispatch).toHaveBeenCalledOnce();
        await remove(removedAccount);
        resume.resolve();
        const result = await settled.promise;
        if (removedAccount === "default") {
          expect(result).toBeInstanceOf(PlatformMessageNotDispatchedError);
          expect(result).toMatchObject({ retryable: false });
        } else {
          expect(result).toBe("901");
        }
        expect(posts).toBe(removedAccount === "default" ? 0 : 1);
      } finally {
        resume.resolve();
        await test.stop();
      }
    },
  );
});
