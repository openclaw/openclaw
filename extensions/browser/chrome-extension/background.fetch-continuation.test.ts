import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionRelayBridge } from "../src/browser/extension-relay/relay-bridge.js";
import {
  connectCdpClient,
  connectExtension,
  deferredScope,
  runtime,
  type CdpFrame as Frame,
} from "./background.lifecycle-test-helpers.js";
import { cleanupBackgroundHarnesses, loadRelayCommandHarness } from "./background.test-harness.js";
type FetchOperation = {
  method: string;
  stage?: "response" | "auth";
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
};
const continueRequest: FetchOperation = { method: "Fetch.continueRequest" };
const targetId = "tab-101";
const authContinuation: FetchOperation = {
  method: "Fetch.continueWithAuth",
  stage: "auth",
  params: { authChallengeResponse: { response: "Default" } },
};
const bodyRead: FetchOperation = {
  method: "Fetch.takeResponseBodyAsStream",
  stage: "response",
  result: { stream: "native-body" },
};
const { deferred, releaseAll } = deferredScope();
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => vi.resetModules());
afterEach(async () => {
  releaseAll();
  await cleanupBackgroundHarnesses();
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  vi.unstubAllGlobals();
});

async function setupTarget(operation = continueRequest) {
  const harness = await loadRelayCommandHarness("selected");
  const bridge = new ExtensionRelayBridge();
  connectExtension(bridge, harness, true);
  const owner = connectCdpClient(bridge);
  const observer = connectCdpClient(bridge);
  cleanups.push(async () => {
    await Promise.all([owner.close(), observer.close()]);
    bridge.dispose();
  });
  for (const client of [owner, observer]) {
    expect(
      await client.request("Target.setAutoAttach", { autoAttach: true, flatten: true }),
    ).toMatchObject({ result: {} });
  }
  const created = await owner.request("Target.createTarget", { url: "about:blank" });
  expect(created).toMatchObject({ result: { targetId: "tab-101" } });
  const session = owner.root(targetId);
  const observerSession = observer.root(targetId);
  const target = bridge.captureOperationTarget(targetId);
  assert(target);
  return { harness, bridge, owner, observer, session, observerSession, target, operation };
}

async function setup(operation = continueRequest) {
  const rig = await setupTarget(operation);
  const { harness, owner, observer, session, observerSession, target } = rig;
  expect(await owner.request("Fetch.enable", { handleAuthRequests: true }, session)).toMatchObject({
    result: {},
  });
  const event = operation.stage === "auth" ? "Fetch.authRequired" : "Fetch.requestPaused";
  harness.debuggerEventListener?.({ tabId: 101 }, event, {
    requestId: "native-navigation-request",
    ...(operation.stage === "response" ? { responseStatusCode: 200 } : {}),
  });
  const requestId = owner.events(event).at(-1)?.params?.requestId;
  assert(typeof requestId === "string");
  assert.notEqual(requestId, "native-navigation-request");
  expect(observer.events(event)).toEqual([]);
  const params: Record<string, unknown> = { ...operation.params, requestId };
  const beforeForeign = harness.debuggerSendCommand.mock.calls.length;
  expect(await observer.request(operation.method, params, observerSession)).toMatchObject({
    error: { message: expect.stringContaining("another session") },
  });
  expect(harness.debuggerSendCommand.mock.calls).toHaveLength(beforeForeign);
  expect(target()).toBe(targetId);
  return { ...rig, params };
}

async function setupConfiguration(method: string) {
  const rig = await setupTarget({ method });
  if (method === "Fetch.disable") {
    expect(await rig.owner.request("Fetch.enable", {}, rig.session)).toMatchObject({ result: {} });
  }
  return { ...rig, params: {} };
}

async function holdNativeCompletion(rig: Awaited<ReturnType<typeof setup>>) {
  const started = deferred(undefined);
  const completed = deferred(undefined);
  const native = rig.harness.debuggerSendCommand.getMockImplementation()!;
  rig.harness.debuggerSendCommand.mockImplementation(async (source, method, params) => {
    if (method !== rig.operation.method) {
      return await native(source, method, params);
    }
    const expectedParams = Object.hasOwn(rig.params, "requestId")
      ? { ...rig.params, requestId: "native-navigation-request" }
      : rig.params;
    expect(params).toEqual(expectedParams);
    started.resolve();
    await completed.promise;
    return rig.operation.result ?? {};
  });
  const id = rig.owner.send(rig.operation.method, rig.params, rig.session);
  await started.promise;
  return { id, complete: completed.resolve };
}

function commitAllowed(rig: Awaited<ReturnType<typeof setup>>) {
  rig.harness.updateTab(101, { url: "https://example.com/destination", pendingUrl: undefined });
  rig.harness.debuggerEventListener?.({ tabId: 101 }, "Page.frameNavigated", {
    frame: {
      id: "frame-101",
      url: "https://example.com/destination",
      loaderId: "destination-loader",
    },
  });
  rig.harness.debuggerEventListener?.({ tabId: 101 }, "Page.lifecycleEvent", {
    name: "load",
    frameId: "frame-101",
  });
}

function nativeCalls(rig: Awaited<ReturnType<typeof setup>>) {
  return rig.harness.debuggerSendCommand.mock.calls.filter(
    ([, method]) => method === rig.operation.method,
  );
}

async function assertReceiptAndContinuity(rig: Awaited<ReturnType<typeof setup>>, response: Frame) {
  expect.soft(response).toMatchObject({ result: {} });
  expect.soft(response.error).toBeUndefined();
  expect.soft(rig.target()).toBe(targetId);
  for (const [client, session] of [
    [rig.owner, rig.session],
    [rig.observer, rig.observerSession],
  ] as const) {
    expect
      .soft(await client.request("Page.getFrameTree", {}, session))
      .toMatchObject({ result: {} });
    const detached = client
      .events("Target.detachedFromTarget")
      .filter((frame) => frame.params?.targetId === targetId);
    expect.soft(detached).toHaveLength(0);
  }
  expect(nativeCalls(rig)).toHaveLength(1);
  expect(rig.bridge.cdpClientCount).toBe(2);
}
async function completeAcrossCommit(
  rig: Awaited<ReturnType<typeof setup>>,
  order: string,
  pending?: () => Promise<void>,
) {
  const held = await holdNativeCompletion(rig);
  if (pending) {
    await pending();
  }
  if (order === "commit-first") {
    commitAllowed(rig);
  }
  held.complete();
  const response = await rig.owner.response(held.id);
  if (order === "completion-first") {
    commitAllowed(rig);
  }
  await assertReceiptAndContinuity(rig, response);
}
// The native completion is the only fault-injected boundary. Real background
// policy, Fetch lease/pause ownership, and both logical relay sessions participate.
describe("Fetch continuation in selected mode", () => {
  it.each([
    { operation: continueRequest, order: "completion-first" },
    { operation: continueRequest, order: "commit-first" },
    { operation: authContinuation, order: "commit-first" },
  ])(
    "preserves $operation.method receipt and both sessions: $order",
    async ({ operation, order }) => {
      await completeAcrossCommit(await setup(operation), order);
    },
  );
  it.each([
    { method: "Fetch.enable", order: "commit-first" },
    { method: "Fetch.disable", order: "completion-first" },
  ])(
    "preserves configuration $method completion ($order) and lease ownership",
    async ({ method, order }) => {
      const rig = await setupConfiguration(method);
      await completeAcrossCommit(rig, order, async () => {
        expect(await rig.observer.request("Fetch.enable", {}, rig.observerSession)).toMatchObject({
          error: { message: expect.stringContaining("another session") },
        });
        expect(nativeCalls(rig)).toHaveLength(1);
      });
      const successor = await rig.observer.request("Fetch.enable", {}, rig.observerSession);
      if (method === "Fetch.disable") {
        expect.soft(successor).toMatchObject({ result: {} });
      } else {
        expect.soft(successor).toMatchObject({
          error: { message: expect.stringContaining("another session") },
        });
        expect(nativeCalls(rig)).toHaveLength(1);
      }
    },
  );
  it("rejects Fetch.enable completion after access revocation", async () => {
    const rig = await setupConfiguration("Fetch.enable");
    const held = await holdNativeCompletion(rig);
    await runtime(rig.harness, "toggleTabAccess", {
      tabId: 101,
      accessMode: "selected",
      grant: false,
    });
    held.complete();
    const response = await rig.owner.response(held.id);
    expect(response.error).toBeDefined();
    expect(response).not.toHaveProperty("result");
    expect(await rig.owner.request("Page.getFrameTree", {}, rig.session)).toHaveProperty("error");
    expect(nativeCalls(rig)).toHaveLength(1);
  });
  it("rejects disable with an unresolved streamed response without retiring its owner", async () => {
    const rig = await setup(bodyRead);
    const held = await holdNativeCompletion(rig);
    held.complete();
    const response = await rig.owner.response(held.id);
    expect(response).toMatchObject({
      result: { stream: expect.stringMatching(/^openclaw-fetch-stream:/) },
    });
    expect(await rig.owner.request("Fetch.disable", {}, rig.session)).toMatchObject({
      error: { message: expect.stringContaining("streamed responses") },
    });
    expect(
      rig.harness.debuggerSendCommand.mock.calls.filter(([, method]) => method === "Fetch.disable"),
    ).toHaveLength(0);
    await assertReceiptAndContinuity(rig, response);
  });
  it("keeps streamed body data document-sensitive", async () => {
    const rig = await setup(bodyRead);
    const held = await holdNativeCompletion(rig);
    commitAllowed(rig);
    held.complete();
    const response = await rig.owner.response(held.id);
    expect(response.error).toBeDefined();
    expect(response).not.toHaveProperty("result");
    expect(nativeCalls(rig)).toHaveLength(1);
  });
  it.each(["attachment", "connection"] as const)(
    "rejects completion after genuine %s revocation",
    async (revocation) => {
      const rig = await setup();
      const held = await holdNativeCompletion(rig);
      switch (revocation) {
        case "attachment":
          rig.harness.debuggerDetachListener?.({ tabId: 101 }, "target_closed");
          break;
        case "connection":
          rig.harness.socket.close();
          break;
      }
      held.complete();
      const response = await rig.owner.response(held.id);
      const successor = await rig.owner.request("Page.getFrameTree", {}, rig.session);
      expect(response.error).toBeDefined();
      expect(response).not.toHaveProperty("result");
      expect(successor.error).toBeDefined();
      expect(nativeCalls(rig)).toHaveLength(1);
    },
  );
});
