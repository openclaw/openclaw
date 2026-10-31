// Signed webhook over real HTTP -> real spool -> real inbound authorization.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it, vi } from "vitest";
import { createAccount as baseAccount, createRuntimeEnv } from "./inbound-media.test-fixtures.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { createSignedCreateMessageRequest } from "./monitor.test-fixtures.js";
import { startWebhookServer } from "./monitor.test-harness.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import { createNextcloudTalkWebhookSpool } from "./webhook-spool.js";

// The shared-state ingress queue requires host-broker admission and a real adoption
// window, which only exist on the process main thread; CI shards run in worker threads,
// so this proof runs locally with OPENCLAW_TALK_WEBHOOK_PROOF=1 and --pool=forks.
describe.skipIf(!isMainThread || process.env.OPENCLAW_TALK_WEBHOOK_PROOF !== "1")(
  "nextcloud-talk access-group admission over a signed webhook",
  () => {
    it("delivers a signed webhook from a room access group under an outer allowlist", async () => {
      const stateDir = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nextcloud-webhook-")),
      );
      try {
        const core = createPluginRuntimeMock();
        core.channel.pairing.readAllowFromStore = vi.fn(async () => []);
        setNextcloudTalkRuntime(core);
        const runtime = createRuntimeEnv();
        const secret = "nextcloud-secret";
        const account = {
          ...baseAccount({
            baseUrl: "",
            secret,
            secretSource: "config",
            config: {
              groupPolicy: "allowlist",
              groupAllowFrom: ["accessGroup:staff"],
              rooms: { "room-1": { requireMention: false, allowFrom: ["accessGroup:staff"] } },
            },
          }),
          baseUrl: "https://cloud.example.com",
        };
        const config = {
          channels: { "nextcloud-talk": account.config },
          accessGroups: {
            staff: { type: "message.senders", members: { "nextcloud-talk": ["alice"] } },
          },
        } as never;

        const abort = new AbortController();
        const deliveries: string[] = [];
        const spool = createNextcloudTalkWebhookSpool({
          accountId: account.accountId,
          queue: createChannelIngressQueueForTests({
            channelId: "nextcloud-talk",
            accountId: account.accountId,
            stateDir,
          }),
          legacyReplayStore: null,
          runtime: {
            error: (message) => deliveries.push(`error:${String(message)}`),
            log: vi.fn(),
          },
          abortSignal: abort.signal,
          adoptionStallTimeoutMs: 60_000,
          deliver: async (message, lifecycle) => {
            deliveries.push("deliver");
            await handleNextcloudTalkInbound({
              message,
              account,
              config,
              runtime,
              turnAdoptionLifecycle: lifecycle,
            });
          },
        });
        await spool.ready();
        const server = await startWebhookServer({
          path: "/nextcloud-access-group",
          secret,
          accountId: account.accountId,
          onWebhook: spool.receive,
        });

        const request = createSignedCreateMessageRequest();
        const response = await fetch(server.webhookUrl, {
          method: "POST",
          headers: request.headers,
          body: request.body,
        });
        expect(response.status).toBe(200);

        await vi.waitFor(
          () => {
            expect(core.channel.inbound.dispatch).toHaveBeenCalledOnce();
          },
          { timeout: 10_000 },
        );
        expect(deliveries).toContain("deliver");

        await server.stop();
        abort.abort();
        await spool.stop();
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });
  },
);
