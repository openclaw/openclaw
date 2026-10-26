import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { collectForRetentionCheck } from "../test-utils/retention.js";
import type { ProviderLocalServiceLease } from "./provider-local-service-target.js";
import {
  ensureProviderLocalService,
  getManagedProviderLocalServiceDiagnosticsForTest,
} from "./provider-local-service.js";
import { createProviderLocalServiceTestFixture } from "./provider-local-service.test-support.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const callerContext = new AsyncLocalStorage<{ label: string; prompt: Buffer }>();
const references: WeakRef<object>[] = [];

async function completedCaller(label: string, operation: () => Promise<void> | void) {
  const caller = { label, prompt: Buffer.alloc(1024 * 1024, "synthetic") };
  references.push(new WeakRef(caller), new WeakRef(caller.prompt));
  await callerContext.run(caller, async () => {
    await operation();
    assert.equal(callerContext.getStore(), caller, "Caller authority must survive its operation");
  });
}

const { complete } = await import("../llm/stream.js");
const model = makeProviderModelFixture<"openai-completions">({
  id: "synthetic",
  api: "openai-completions",
  provider: "synthetic",
  baseUrl: "http://127.0.0.1:1",
});
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
const { port1, port2 } = new MessageChannel();
const closed = once(port1, "close");
port1.close();
port2.close();
await closed;
assert.equal(nativePortIsOpen(port1), false);

const fixture = createProviderLocalServiceTestFixture();
try {
  const port = await fixture.claimPort();
  const target = {
    providerId: "synthetic-retention",
    baseUrl: `http://127.0.0.1:${port}`,
    service: {
      command: process.execPath,
      args: [
        "-e",
        `require("node:http").createServer((req,res)=>res.end(String(process.pid))).listen(${port},"127.0.0.1");`,
      ],
      healthUrl: `http://127.0.0.1:${port}/models`,
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
  assert.ok(
    references.every((reference) => reference.deref() === undefined),
    "Lifecycle resources retained completed callers",
  );
  const reused = await ensureProviderLocalService(target);
  assert.ok(reused, "The managed service must remain reusable after caller collection");
  assert.equal(getManagedProviderLocalServiceDiagnosticsForTest()[0]?.pid, pid);
  reused.release();
  process.stdout.write(JSON.stringify({ collected: references.length, reused: true }));
} finally {
  await fixture.cleanup();
}
