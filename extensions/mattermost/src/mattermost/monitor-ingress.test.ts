import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMattermostIngressMonitor } from "./monitor-ingress.js";

type MattermostIngressQueue = NonNullable<
  Parameters<typeof createMattermostIngressMonitor>[0]["queue"]
>;
type MattermostIngressPayload = Parameters<MattermostIngressQueue["enqueue"]>[1];
type MattermostIngressDispatch = Parameters<typeof createMattermostIngressMonitor>[0]["dispatch"];
const adopt: MattermostIngressDispatch = async (_post, _payload, lifecycle) => {
  await lifecycle.onAdopted();
};

function interceptAdmission(
  queue: MattermostIngressQueue,
  intercept: <T>(write: () => Promise<T>) => Promise<T>,
) {
  const enqueue = queue.enqueue.bind(queue);
  queue.enqueue = (...args) => intercept(() => enqueue(...args));
  // Idle ingress can append and claim atomically; storage gates must cover both entry points.
  const enqueueAndClaim = queue.enqueueAndClaim?.bind(queue);
  if (enqueueAndClaim) {
    queue.enqueueAndClaim = (...args) => intercept(() => enqueueAndClaim(...args));
  }
}

function postedEvent(
  postId = "post-1",
  event: "posted" | "post_edited" = "posted",
  channelId = "channel-1",
): string {
  return JSON.stringify({
    event,
    data: {
      post: JSON.stringify({
        id: postId,
        channel_id: channelId,
        user_id: "user-1",
        message: "hello",
      }),
    },
  });
}

let stateDir: string;
let queue: MattermostIngressQueue;
let defaultDispatch: ReturnType<typeof vi.fn<MattermostIngressDispatch>>;
const monitors = new Set<ReturnType<typeof createMattermostIngressMonitor>>();
function startMonitor(
  dispatch: MattermostIngressDispatch = defaultDispatch,
  runtime: Parameters<typeof createMattermostIngressMonitor>[0]["runtime"] = {
    error: vi.fn(),
    log: vi.fn(),
  },
) {
  const monitor = createMattermostIngressMonitor({
    accountId: "default",
    queue,
    dispatch,
    runtime,
    pollIntervalMs: 60_000,
    adoptionStallTimeoutMs: 5_000,
  });
  monitors.add(monitor);
  return monitor;
}

function authorlessEvent() {
  return JSON.stringify({
    event: "posted",
    data: {
      post: JSON.stringify({
        id: "post-missing-author",
        channel_id: "channel-1",
        message: "hello",
      }),
    },
    broadcast: { channel_id: "channel-1", user_id: "broadcast-user" },
  });
}
async function expectDeadLetter(ingressQueue: MattermostIngressQueue, id: string) {
  expect((await ingressQueue.enqueue(id, {} as MattermostIngressPayload)).kind).toBe("failed");
}

beforeEach(async () => {
  stateDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mattermost-ingress-")),
  );
  queue = createChannelIngressQueueForTests<MattermostIngressPayload>({
    channelId: "mattermost",
    accountId: "default",
    stateDir,
  });
  defaultDispatch = vi.fn<MattermostIngressDispatch>();
});
afterEach(async () => {
  await Promise.all([...monitors].map((monitor) => monitor.stop()));
  monitors.clear();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  await fs.rm(stateDir, { recursive: true, force: true });
});

it("visibly rejects an authorless event without disconnecting subsequent ingress", async () => {
  const enqueue = vi.spyOn(queue, "enqueue");
  const runtime = { error: vi.fn(), log: vi.fn() };
  const monitor = startMonitor(defaultDispatch, runtime);
  await monitor.receive(authorlessEvent());
  expect(enqueue).not.toHaveBeenCalled();
  expect(defaultDispatch).not.toHaveBeenCalled();
  expect(runtime.error).toHaveBeenCalledWith(
    expect.stringContaining("Mattermost posted event is missing post.user_id"),
  );

  await monitor.receive(postedEvent("post-after-invalid"));
  await vi.waitFor(() => expect(defaultDispatch).toHaveBeenCalledTimes(1));
});

it("does not let ignored post_edited events tombstone a later posted event", async () => {
  defaultDispatch.mockImplementation(adopt);
  const monitor = startMonitor();
  await monitor.receive(postedEvent("post-edit", "post_edited"));
  await monitor.waitForIdle();
  await monitor.receive(postedEvent("post-edit", "posted"));
  await monitor.waitForIdle();
  expect(defaultDispatch).toHaveBeenCalledTimes(1);
});

it("surfaces persistent storage failures to the transport", async () => {
  interceptAdmission(queue, async () => {
    throw new Error("sqlite busy");
  });
  await expect(startMonitor().receive(postedEvent("post-lost"))).rejects.toThrow("sqlite busy");
});

it("accepts a post whose channel id arrives at the envelope level", async () => {
  const dispatched: string[] = [];
  const ingress = startMonitor(async (post, _payload, lifecycle) => {
    dispatched.push(post.id);
    await lifecycle.onAdopted();
  });
  await ingress.receive(
    JSON.stringify({
      event: "posted",
      data: {
        channel_id: "channel-envelope",
        post: JSON.stringify({ id: "post-envelope", user_id: "user-1", message: "hi" }),
      },
    }),
  );
  await vi.waitFor(() => expect(dispatched).toEqual(["post-envelope"]));
});

const persist = (id: string, rawEvent: string) =>
  queue.enqueue(
    id,
    { version: 1, receivedAt: 1, rawEvent },
    { receivedAt: 1, laneKey: "channel:channel-1" },
  );

it.each([
  ["malformed JSON", "post-malformed", "{"],
  ["authorless post with broadcast recipient", "post-missing-author", authorlessEvent()],
])("dead-letters persisted %s without retry", async (_name, id, raw) => {
  await persist(id, raw);
  await startMonitor().waitForIdle();
  await expectDeadLetter(queue, id);
  expect(defaultDispatch).not.toHaveBeenCalled();
});
