// Msteams tests cover durable card-action admission, replay, retry, and dedupe.
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createMSTeamsCardActionIngress } from "./card-action-ingress.js";
import type { MSTeamsApp } from "./sdk.js";
import type { MSTeamsActivity } from "./sdk-types.js";

type MSTeamsCardActionIngressPayload = {
  version: 1;
  receivedAt: number;
  activity: MSTeamsActivity;
};

const disposers: Array<() => void> = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    for (const dispose of disposers.splice(0).toReversed()) {
      dispose();
    }
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

function createStateDir(): string {
  return tempDirs.make("openclaw-msteams-card-action-");
}

function createQueue(stateDir: string) {
  return createChannelIngressQueueForTests<MSTeamsCardActionIngressPayload>({
    channelId: "msteams",
    accountId: "default",
    stateDir,
  });
}

function createActivity(id = "invoke-1"): MSTeamsActivity {
  return {
    type: "invoke",
    name: "adaptiveCard/action",
    id,
    timestamp: "2026-07-17T08:00:00.000Z",
    serviceUrl: "https://smba.trafficmanager.net/emea",
    channelId: "msteams",
    from: { id: "29:user", aadObjectId: "aad-user", name: "Ada" },
    recipient: { id: "28:bot", name: "OpenClaw" },
    conversation: {
      id: "19:conversation;messageid=thread-root",
      conversationType: "channel",
    },
    channelData: {
      team: { id: "team-1" },
      tenant: { id: "tenant-1" },
    },
    value: { action: { data: { action: "approve" } } },
  };
}

function createApp() {
  const create = vi.fn(async () => ({ id: "reply-1" }));
  const activities = vi.fn(() => ({
    create,
    update: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  }));
  const app = {
    api: {
      serviceUrl: "https://smba.trafficmanager.net/emea",
      teams: { getById: vi.fn(async () => ({ aadGroupId: "group-1" })) },
      conversations: { activities },
    },
  } as unknown as MSTeamsApp;
  return { app, activities, create };
}

async function drain(ingress: ReturnType<typeof createMSTeamsCardActionIngress>) {
  await ingress.drainOnce();
  await ingress.waitForIdle();
}

describe("createMSTeamsCardActionIngress", () => {
  it("commits a pending SQLite row before enqueue resolves", async () => {
    const stateDir = createStateDir();
    const queue = createQueue(stateDir);
    const { app } = createApp();
    const ingress = createMSTeamsCardActionIngress({
      app,
      queue,
      dispatch: vi.fn(async () => {}),
    });
    disposers.push(ingress.dispose);

    await expect(ingress.enqueue(createActivity())).resolves.toMatchObject({
      kind: "accepted",
      duplicate: false,
    });
    await expect(queue.listPending()).resolves.toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ version: 1 }),
        laneKey: "conversation:19:conversation",
      }),
    ]);
  });

  it("recovers after restart and targets the original Teams thread proactively", async () => {
    const stateDir = createStateDir();
    const firstApp = createApp();
    const first = createMSTeamsCardActionIngress({
      app: firstApp.app,
      queue: createQueue(stateDir),
      dispatch: vi.fn(async () => {}),
    });
    disposers.push(first.dispose);
    await first.enqueue(createActivity("invoke-restart"));
    first.dispose();

    const secondApp = createApp();
    const dispatch = vi.fn(async (context) => {
      await context.sendActivity("recovered");
    });
    const recovered = createMSTeamsCardActionIngress({
      app: secondApp.app,
      queue: createQueue(stateDir),
      dispatch,
    });
    disposers.push(recovered.dispose);
    await drain(recovered);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(secondApp.activities).toHaveBeenCalledWith(
      "19:conversation;messageid=thread-root",
    );
    expect(secondApp.create).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({ id: "19:conversation;messageid=thread-root" }),
        channelData: expect.objectContaining({ tenant: { id: "tenant-1" } }),
      }),
    );
  });

  it("retries a transient dispatch failure without a restart", async () => {
    const stateDir = createStateDir();
    const { app } = createApp();
    let now = 1_000;
    const dispatch = vi
      .fn<(context: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary dispatch failure"))
      .mockResolvedValue(undefined);
    const ingress = createMSTeamsCardActionIngress({
      app,
      queue: createQueue(stateDir),
      dispatch,
      now: () => now,
      retryPolicy: { baseMs: 10, maxMs: 10 },
    });
    disposers.push(ingress.dispose);
    await ingress.enqueue(createActivity("invoke-retry"));

    await drain(ingress);
    expect(dispatch).toHaveBeenCalledTimes(1);
    now += 10;
    await drain(ingress);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not retry an error after the reply lane durably adopts the turn", async () => {
    const stateDir = createStateDir();
    const { app } = createApp();
    const dispatch = vi.fn(async (_context, lifecycle) => {
      await lifecycle.onAdopted();
      throw new Error("post-adoption failure");
    });
    const ingress = createMSTeamsCardActionIngress({
      app,
      queue: createQueue(stateDir),
      dispatch,
      retryPolicy: { baseMs: 0, maxMs: 0 },
    });
    disposers.push(ingress.dispose);
    await ingress.enqueue(createActivity("invoke-adopted"));

    await drain(ingress);
    await drain(ingress);

    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("claim-fences duplicate delivery across concurrent drain instances", async () => {
    const stateDir = createStateDir();
    const { app } = createApp();
    const dispatch = vi.fn(async () => {});
    const first = createMSTeamsCardActionIngress({
      app,
      queue: createQueue(stateDir),
      dispatch,
    });
    const second = createMSTeamsCardActionIngress({
      app,
      queue: createQueue(stateDir),
      dispatch,
    });
    disposers.push(first.dispose, second.dispose);

    await first.enqueue(createActivity("invoke-duplicate"));
    await second.enqueue(createActivity("invoke-duplicate"));
    await Promise.all([first.drainOnce(), second.drainOnce()]);
    await Promise.all([first.waitForIdle(), second.waitForIdle()]);

    expect(dispatch).toHaveBeenCalledOnce();
  });
});
