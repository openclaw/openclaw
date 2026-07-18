// Googlechat tests cover durable webhook admission and replay.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleChatIngressSpool, type GoogleChatIngressPayload } from "./monitor-ingress.js";
import type { GoogleChatRuntimeEnv } from "./monitor-types.js";
import type { GoogleChatEvent } from "./types.js";

const runtime: GoogleChatRuntimeEnv = { log: vi.fn(), error: vi.fn() };

const stateDirs: string[] = [];
const disposers: Array<() => void> = [];
type GoogleChatIngressDeliver = Parameters<typeof createGoogleChatIngressSpool>[0]["deliver"];
type GoogleChatIngressSpool = ReturnType<typeof createGoogleChatIngressSpool>;

async function createStateDir(): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), "openclaw-googlechat-ingress-"));
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

function messageEvent(messageName: string): GoogleChatEvent {
  return {
    type: "MESSAGE",
    space: { name: "spaces/AAA" },
    message: { name: messageName, text: "hello", sender: { name: "users/123" } },
    user: { name: "users/123" },
    eventTime: "2026-03-22T00:00:00.000Z",
  } as GoogleChatEvent;
}

function track(spool: GoogleChatIngressSpool): GoogleChatIngressSpool {
  disposers.push(spool.dispose);
  return spool;
}

async function drainSpool(spool: GoogleChatIngressSpool): Promise<void> {
  await spool.drainOnce();
  await spool.waitForIdle();
}

afterEach(async () => {
  for (const dispose of disposers.splice(0).toReversed()) {
    dispose();
  }
  for (const stateDir of stateDirs.splice(0).toReversed()) {
    await rm(stateDir, { recursive: true, force: true });
  }
});

describe("createGoogleChatIngressSpool", () => {
  it("recovers an acknowledged-but-undispatched message with a fresh drain instance", async () => {
    const stateDir = await createStateDir();
    const first = track(
      createGoogleChatIngressSpool({
        accountId: "default",
        runtime,
        queue: createQueue(stateDir),
        deliver: vi.fn<GoogleChatIngressDeliver>(async () => undefined),
      }),
    );
    await first.enqueue(messageEvent("spaces/AAA/messages/restart"));
    // Simulate a crash after the webhook ack but before any dispatch ran.
    first.dispose();

    const deliver = vi.fn<GoogleChatIngressDeliver>(async (_event, lifecycle) => {
      await lifecycle.onAdopted();
    });
    const recovered = track(
      createGoogleChatIngressSpool({
        accountId: "default",
        runtime,
        queue: createQueue(stateDir),
        deliver,
      }),
    );
    await drainSpool(recovered);

    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({
      type: "MESSAGE",
      message: { name: "spaces/AAA/messages/restart", text: "hello" },
    });
  });

  it("reclaims a message whose dispatch was claimed when the gateway died", async () => {
    const stateDir = await createStateDir();
    const blockedDeliver = vi.fn<GoogleChatIngressDeliver>(() => new Promise<void>(() => {}));
    const first = track(
      createGoogleChatIngressSpool({
        accountId: "default",
        runtime,
        queue: createQueue(stateDir),
        deliver: blockedDeliver,
      }),
    );
    await first.enqueue(messageEvent("spaces/AAA/messages/claimed"));
    await first.drainOnce();
    expect(blockedDeliver).toHaveBeenCalledOnce();
    // Crash mid-dispatch: the claim is still held by the disposed owner.
    first.dispose();

    const deliver = vi.fn<GoogleChatIngressDeliver>(async (_event, lifecycle) => {
      await lifecycle.onAdopted();
    });
    const recovered = track(
      createGoogleChatIngressSpool({
        accountId: "default",
        runtime,
        queue: createQueue(stateDir),
        deliver,
      }),
    );
    await drainSpool(recovered);

    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({
      message: { name: "spaces/AAA/messages/claimed" },
    });
  });

  it("keeps a completed message tombstone from dispatching twice", async () => {
    const stateDir = await createStateDir();
    const deliver = vi.fn<GoogleChatIngressDeliver>(async (_event, lifecycle) => {
      await lifecycle.onAdopted();
    });
    const spool = track(
      createGoogleChatIngressSpool({
        accountId: "default",
        runtime,
        queue: createQueue(stateDir),
        deliver,
      }),
    );

    expect(await spool.enqueue(messageEvent("spaces/AAA/messages/dup"))).toMatchObject({
      kind: "accepted",
      duplicate: false,
    });
    await drainSpool(spool);
    expect(await spool.enqueue(messageEvent("spaces/AAA/messages/dup"))).toMatchObject({
      kind: "completed",
      duplicate: true,
    });
    await drainSpool(spool);

    expect(deliver).toHaveBeenCalledOnce();
  });

  it("uses the space as the durable lane", async () => {
    const stateDir = await createStateDir();
    const queue = createQueue(stateDir);
    const spool = track(
      createGoogleChatIngressSpool({
        accountId: "default",
        runtime,
        queue,
        deliver: vi.fn<GoogleChatIngressDeliver>(async () => undefined),
      }),
    );

    await spool.enqueue(messageEvent("spaces/AAA/messages/lane"));

    expect(await queue.listPending()).toEqual([
      expect.objectContaining({ laneKey: "space:spaces/AAA" }),
    ]);
  });

  it("refuses to journal a MESSAGE event without a message name", async () => {
    const stateDir = await createStateDir();
    const spool = track(
      createGoogleChatIngressSpool({
        accountId: "default",
        runtime,
        queue: createQueue(stateDir),
        deliver: vi.fn<GoogleChatIngressDeliver>(async () => undefined),
      }),
    );
    const event = messageEvent("");
    delete event.message?.name;

    await expect(spool.enqueue(event)).rejects.toThrow("missing message.name");
    expect(await createQueue(stateDir).listPending()).toEqual([]);
  });
});
