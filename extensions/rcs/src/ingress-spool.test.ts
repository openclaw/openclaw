// Rcs tests cover durable Twilio webhook admission and replay.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RcsChannelRuntime } from "./inbound.js";
import { createRcsIngressSpool } from "./ingress-spool.js";
import type { ResolvedRcsAccount } from "./types.js";

type RcsIngressPayload = {
  version: 1;
  form: Record<string, string>;
};

const account: ResolvedRcsAccount = {
  accountId: "default",
  enabled: true,
  accountSid: "AC123",
  authToken: "secret",
  messagingServiceSid: "MG123",
  senderId: "",
  transport: "rcs-only",
  defaultTo: "",
  webhookPath: "/webhooks/rcs",
  publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
  sharedWebhookPath: "",
  sharedWebhookPublicUrl: "",
  smsForwardWebhookPath: "",
  statusCallbacks: true,
  dangerouslyDisableSignatureValidation: false,
  dmPolicy: "pairing",
  allowFrom: [],
  textChunkLimit: 3000,
};

const stateDirs: string[] = [];
const disposers: Array<() => void | Promise<void>> = [];
type RcsIngressDeliver = NonNullable<Parameters<typeof createRcsIngressSpool>[0]["deliver"]>;
type RcsIngressSpool = ReturnType<typeof createRcsIngressSpool>;

async function createStateDir(): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), "openclaw-rcs-ingress-"));
  const resolved = await realpath(created);
  stateDirs.push(resolved);
  return resolved;
}

function createQueue(stateDir: string) {
  return createChannelIngressQueueForTests<RcsIngressPayload>({
    channelId: "rcs",
    accountId: account.accountId,
    stateDir,
  });
}

function form(messageSid: string): Record<string, string> {
  return {
    AccountSid: account.accountSid,
    From: "rcs:+15551234567",
    To: "rcs:example_agent",
    Body: "hello",
    MessageSid: messageSid,
  };
}

async function drainSpool(spool: RcsIngressSpool): Promise<void> {
  spool.start();
  await spool.waitForIdle();
}

afterEach(async () => {
  for (const dispose of disposers.splice(0).toReversed()) {
    await dispose();
  }
  for (const stateDir of stateDirs.splice(0).toReversed()) {
    await rm(stateDir, { recursive: true, force: true });
  }
});

describe("createRcsIngressSpool", () => {
  it("recovers an uncompleted message with a fresh drain instance", async () => {
    const stateDir = await createStateDir();
    const first = createRcsIngressSpool({
      cfg: {},
      account,
      channelRuntime: {} as RcsChannelRuntime,
      queue: createQueue(stateDir),
      deliver: vi.fn<RcsIngressDeliver>(async () => undefined),
    });
    disposers.push(first.stop);
    await first.enqueue(form("SM-restart"));
    await first.stop();

    const deliver = vi.fn<RcsIngressDeliver>(async (_message, lifecycle) => {
      await lifecycle.onAdopted();
    });
    const recovered = createRcsIngressSpool({
      cfg: {},
      account,
      channelRuntime: {} as RcsChannelRuntime,
      queue: createQueue(stateDir),
      deliver,
    });
    disposers.push(recovered.stop);
    await drainSpool(recovered);

    expect(deliver).toHaveBeenCalledOnce();
  });

  it("durably admits a handler selected before route shutdown", async () => {
    const stateDir = await createStateDir();
    const retired = createRcsIngressSpool({
      cfg: {},
      account,
      channelRuntime: {} as RcsChannelRuntime,
      queue: createQueue(stateDir),
      deliver: vi.fn<RcsIngressDeliver>(async () => undefined),
    });
    disposers.push(retired.stop);
    retired.start();
    await retired.stop();

    await expect(retired.enqueue(form("SM-late-handler"))).resolves.toMatchObject({
      kind: "accepted",
    });
    const deliver = vi.fn<RcsIngressDeliver>(async (_message, lifecycle) => {
      await lifecycle.onAdopted();
    });
    const recovered = createRcsIngressSpool({
      cfg: {},
      account,
      channelRuntime: {} as RcsChannelRuntime,
      queue: createQueue(stateDir),
      deliver,
    });
    disposers.push(recovered.stop);
    await drainSpool(recovered);

    expect(deliver).toHaveBeenCalledOnce();
  });

  it("keeps a completed MessageSid tombstone from dispatching twice", async () => {
    const stateDir = await createStateDir();
    const deliver = vi.fn<RcsIngressDeliver>(async (_message, lifecycle) => {
      await lifecycle.onAdopted();
    });
    const spool = createRcsIngressSpool({
      cfg: {},
      account,
      channelRuntime: {} as RcsChannelRuntime,
      queue: createQueue(stateDir),
      deliver,
    });
    disposers.push(spool.stop);

    expect(await spool.enqueue(form("SM-completed"))).toMatchObject({
      kind: "accepted",
      duplicate: false,
    });
    await drainSpool(spool);
    expect(await spool.enqueue(form("SM-completed"))).toMatchObject({
      kind: "completed",
      duplicate: true,
    });
    await drainSpool(spool);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it.each(["SmsSid", "SmsMessageSid"])("accepts the legacy %s event id alias", async (key) => {
    const stateDir = await createStateDir();
    const deliver = vi.fn<RcsIngressDeliver>(async (_message, lifecycle) => {
      await lifecycle.onAdopted();
    });
    const spool = createRcsIngressSpool({
      cfg: {},
      account,
      channelRuntime: {} as RcsChannelRuntime,
      queue: createQueue(stateDir),
      deliver,
    });
    disposers.push(spool.stop);
    const rawForm = form("SM-alias");
    delete rawForm.MessageSid;
    rawForm[key] = "SM-alias";

    await spool.enqueue(rawForm);
    await drainSpool(spool);
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ messageSid: "SM-alias" }),
      expect.any(Object),
      expect.any(Number),
    );
  });

  it("uses the canonical sender as the durable lane", async () => {
    const stateDir = await createStateDir();
    const queue = createQueue(stateDir);
    const spool = createRcsIngressSpool({
      cfg: {},
      account,
      channelRuntime: {} as RcsChannelRuntime,
      queue,
      deliver: vi.fn<RcsIngressDeliver>(async () => undefined),
    });
    disposers.push(spool.stop);

    await spool.enqueue({ ...form("SM-canonical-lane"), From: "RcS:+1 (555) 123-4567" });
    expect(await queue.listPending()).toEqual([
      expect.objectContaining({ laneKey: "sender:+15551234567" }),
    ]);
  });

  it("replays with the original webhook receipt timestamp", async () => {
    const stateDir = await createStateDir();
    const receivedAt = 1_700_000_000_456;
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(receivedAt)
      .mockReturnValue(receivedAt + 60_000);
    const first = createRcsIngressSpool({
      cfg: {},
      account,
      channelRuntime: {} as RcsChannelRuntime,
      queue: createQueue(stateDir),
      deliver: vi.fn<RcsIngressDeliver>(async () => undefined),
    });
    disposers.push(first.stop);
    await first.enqueue(form("SM-received-at"));
    await first.stop();
    now.mockRestore();

    const deliver = vi.fn<RcsIngressDeliver>(async (_message, lifecycle) => {
      await lifecycle.onAdopted();
    });
    const recovered = createRcsIngressSpool({
      cfg: {},
      account,
      channelRuntime: {} as RcsChannelRuntime,
      queue: createQueue(stateDir),
      deliver,
    });
    disposers.push(recovered.stop);
    await drainSpool(recovered);
    expect(deliver).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), receivedAt);
  });

  it.each([
    ["invalid payload", { MessageSid: "SM-invalid", From: "rcs:+15551234567" }],
    ["account mismatch", { ...form("SM-account"), AccountSid: "AC-other" }],
  ])("dead-letters a permanent %s failure", async (_label, rawForm) => {
    const stateDir = await createStateDir();
    const deliver = vi.fn<RcsIngressDeliver>(async () => undefined);
    const spool = createRcsIngressSpool({
      cfg: {},
      account,
      channelRuntime: {} as RcsChannelRuntime,
      queue: createQueue(stateDir),
      deliver,
    });
    disposers.push(spool.stop);

    await spool.enqueue(rawForm);
    await drainSpool(spool);
    expect(await spool.enqueue(rawForm)).toMatchObject({ kind: "failed", duplicate: true });
    expect(deliver).not.toHaveBeenCalled();
  });
});
