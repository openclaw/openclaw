import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import type { Model } from "../llm/types.js";
import { collectForRetentionCheck } from "../test-utils/retention.js";
import type { ProviderLocalServiceLease } from "./provider-local-service-target.js";
import {
  ensureProviderLocalService,
  getManagedProviderLocalServiceDiagnosticsForTest,
} from "./provider-local-service.js";
import { createProviderLocalServiceTestFixture } from "./provider-local-service.test-support.js";

const [root] = process.argv.slice(2);
assert.ok(root, "Lifecycle retention fixture requires its temporary directory");

class LifecycleCreationCaller {
  readonly prompt = Buffer.alloc(1024 * 1024, "synthetic");
  constructor(readonly label: string) {}
}
const callerContext = new AsyncLocalStorage<LifecycleCreationCaller>();
const references: { label: string; reference: WeakRef<object> }[] = [];

async function completedCaller(label: string, operation: () => Promise<void> | void) {
  const caller = new LifecycleCreationCaller(label);
  references.push(
    { label, reference: new WeakRef(caller) },
    { label: `${label} prompt`, reference: new WeakRef(caller.prompt) },
  );
  await callerContext.run(caller, async () => {
    await operation();
    assert.equal(callerContext.getStore(), caller, "Caller authority must survive its operation");
  });
}

const { complete } = await import("../llm/stream.js");
const model: Model<"openai-completions"> = {
  id: "synthetic",
  name: "Synthetic",
  api: "openai-completions",
  provider: "synthetic",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 128,
};
await completedCaller("LLM initialization", async () => {
  const stopped = new Error("synthetic request finished after host initialization");
  await assert.rejects(
    complete(model, { messages: [] }, undefined, () => {
      assert.equal(callerContext.getStore()?.label, "LLM initialization");
      throw stopped;
    }),
    (error: unknown) => error === stopped,
  );
});

const { nativePortIsOpen } = await import("../infra/worker-native-port.js");
const channel = new MessageChannel();
try {
  assert.equal(nativePortIsOpen(channel.port1), true);
  channel.port1.postMessage("still owned");
  assert.deepEqual(receiveMessageOnPort(channel.port2), { message: "still owned" });
  const closed = once(channel.port1, "close");
  channel.port1.close();
  await closed;
  assert.equal(nativePortIsOpen(channel.port1), false);
} finally {
  channel.port1.close();
  channel.port2.close();
}

const fixture = createProviderLocalServiceTestFixture();
try {
  const port = await fixture.claimPort();
  const healthUrl = `http://127.0.0.1:${port}/models`;
  const target = {
    providerId: "synthetic-retention",
    baseUrl: `http://127.0.0.1:${port}`,
    service: {
      command: process.execPath,
      args: [
        "-e",
        `require("node:http").createServer((req,res)=>res.end(String(process.pid))).listen(${port},"127.0.0.1");`,
      ],
      healthUrl,
      readyTimeoutMs: 10_000,
      idleStopMs: 600_000,
    },
  };
  let lease: ProviderLocalServiceLease | undefined;
  await completedCaller("provider child", async () => {
    lease = await ensureProviderLocalService(target);
    assert.ok(lease, "The first request must start a real managed child");
  });
  const pid = getManagedProviderLocalServiceDiagnosticsForTest()[0]?.pid;
  assert.ok(pid, "The managed child must have spawned");
  await completedCaller("provider idle timer", () => {
    lease?.release();
    lease = undefined;
  });
  await collectForRetentionCheck("lifecycle-creation");
  const retained = references
    .filter(({ reference }) => reference.deref())
    .map(({ label }) => label);
  assert.deepEqual(retained, [], "Lifecycle resources retained completed callers");
  const reused = await ensureProviderLocalService(target);
  assert.ok(reused, "The managed service must remain reusable after caller collection");
  assert.equal(getManagedProviderLocalServiceDiagnosticsForTest()[0]?.pid, pid);
  reused.release();
  process.stdout.write(JSON.stringify({ collected: references.length, reused: true }));
} finally {
  await fixture.cleanup();
}
