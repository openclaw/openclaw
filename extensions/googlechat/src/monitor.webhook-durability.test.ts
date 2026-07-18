// Googlechat tests cover webhook durability across a simulated gateway restart.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { createFixedWindowRateLimiter } from "openclaw/plugin-sdk/webhook-ingress";
import { createWebhookInFlightLimiter } from "openclaw/plugin-sdk/webhook-request-guards";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatIngressPayload } from "./monitor-ingress.js";
import { createGoogleChatIngressSpool } from "./monitor-ingress.js";
import type { WebhookTarget } from "./monitor-types.js";
import { createGoogleChatWebhookRequestHandler } from "./monitor-webhook.js";
import type { GoogleChatEvent } from "./types.js";

vi.mock("./auth.js", () => ({
  verifyGoogleChatRequest: vi.fn(async () => ({ ok: true })),
}));

const stateDirs: string[] = [];
const disposers: Array<() => void> = [];

async function createStateDir(): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), "openclaw-googlechat-webhook-"));
  const resolved = await realpath(created);
  stateDirs.push(resolved);
  return resolved;
}

function createQueue(stateDir: string) {
  return createChannelIngressQueueForTests<GoogleChatIngressPayload>({
    channelId: "googlechat",
    accountId: "default",
    stateDir,
  });
}

function createSpool(params: {
  stateDir: string;
  deliver: (
    event: GoogleChatEvent,
    lifecycle: { onAdopted: () => void | Promise<void> },
  ) => Promise<void>;
}) {
  const spool = createGoogleChatIngressSpool({
    accountId: "default",
    runtime: { log: vi.fn(), error: vi.fn() },
    queue: createQueue(params.stateDir),
    deliver: params.deliver,
  });
  disposers.push(spool.dispose);
  return spool;
}

const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "none",
  config: {},
} as ResolvedGoogleChatAccount;

const inboundEvent = {
  type: "MESSAGE",
  space: { name: "spaces/AAA" },
  message: {
    name: "spaces/AAA/messages/durable-1",
    text: "are you there?",
    sender: { name: "users/123", displayName: "Real User" },
  },
  user: { name: "users/123", displayName: "Real User" },
  eventTime: "2026-03-22T00:00:00.000Z",
};

afterEach(async () => {
  for (const dispose of disposers.splice(0).toReversed()) {
    dispose();
  }
  for (const stateDir of stateDirs.splice(0).toReversed()) {
    await rm(stateDir, { recursive: true, force: true });
  }
});

afterAll(() => {
  vi.doUnmock("./auth.js");
  vi.resetModules();
});

describe("Google Chat webhook durability", () => {
  it("replays a 200-acked message after a restart that killed dispatch", async () => {
    const stateDir = await createStateDir();
    // The pre-restart deliver never runs: the gateway dies between the webhook
    // ack and the first drain, which is exactly the old loss window.
    const deliverBeforeRestart = vi.fn(async () => undefined);
    const spoolBeforeRestart = createSpool({
      stateDir,
      deliver: deliverBeforeRestart,
    });
    const statusSink = vi.fn();
    const target: WebhookTarget = {
      account,
      config: {} as OpenClawConfig,
      runtime: { log: vi.fn(), error: vi.fn() },
      core: {} as WebhookTarget["core"],
      path: "/googlechat",
      statusSink,
      mediaMaxMb: 5,
      ingress: spoolBeforeRestart,
    };
    const handler = createGoogleChatWebhookRequestHandler({
      webhookTargets: new Map([[target.path, [target]]]),
      webhookRateLimiter: createFixedWindowRateLimiter({ windowMs: 60_000, maxRequests: 1_000 }),
      webhookInFlightLimiter: createWebhookInFlightLimiter(),
      processEvent: vi.fn(async () => undefined),
    });

    await withServer(
      (req, res) => {
        void handler(req, res);
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/googlechat`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test-token",
          },
          body: JSON.stringify(inboundEvent),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({});
      },
    );

    // Google saw a 200, but dispatch never ran.
    expect(deliverBeforeRestart).not.toHaveBeenCalled();
    // The event is durable in the shared-state ingress queue.
    expect(await createQueue(stateDir).listPending()).toEqual([
      expect.objectContaining({
        id: "spaces/AAA/messages/durable-1",
        laneKey: "space:spaces/AAA",
      }),
    ]);
    // Crash: nothing graceful, the owning monitor is gone.
    spoolBeforeRestart.dispose();

    const deliverAfterRestart = vi.fn(
      async (_event: GoogleChatEvent, lifecycle: { onAdopted: () => Promise<void> }) => {
        await lifecycle.onAdopted();
      },
    );
    const spoolAfterRestart = createSpool({ stateDir, deliver: deliverAfterRestart });
    await spoolAfterRestart.drainOnce();
    await spoolAfterRestart.waitForIdle();

    expect(deliverAfterRestart).toHaveBeenCalledOnce();
    expect(deliverAfterRestart.mock.calls[0]?.[0]).toMatchObject({
      type: "MESSAGE",
      space: { name: "spaces/AAA" },
      message: { name: "spaces/AAA/messages/durable-1", text: "are you there?" },
      user: { name: "users/123" },
      eventTime: "2026-03-22T00:00:00.000Z",
    });

    // The completed tombstone survives the restart too: no second dispatch.
    spoolAfterRestart.dispose();
    const deliverAfterSecondRestart = vi.fn(async () => undefined);
    const spoolAfterSecondRestart = createSpool({
      stateDir,
      deliver: deliverAfterSecondRestart,
    });
    await spoolAfterSecondRestart.drainOnce();
    await spoolAfterSecondRestart.waitForIdle();
    expect(deliverAfterSecondRestart).not.toHaveBeenCalled();
  });
});
