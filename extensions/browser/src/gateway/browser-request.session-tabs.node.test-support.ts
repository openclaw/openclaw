import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { GatewayRequestHandlers, NodeSession } from "openclaw/plugin-sdk/gateway-runtime";
import { createTestGatewayRequestContext } from "openclaw/plugin-sdk/plugin-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { expect, vi } from "vitest";
import {
  createBrowserNodeProxyRequest,
  createBrowserNodeSessionTabRoute,
} from "../browser-node-proxy.js";
import { getBrowserStateRuntime } from "../browser-runtime-state.js";
import { captureBrowserNodeOpenCleanup } from "../browser-tool-session-tabs.js";
import * as cdpHelpers from "../browser/cdp.helpers.js";
import * as cdp from "../browser/cdp.js";
import * as proxyFiles from "../browser/proxy-files.js";
import { withBrowserRequestScope } from "../browser/request-scope.js";
import { prepareBrowserSessionScope } from "../browser/session-scope.js";
import { volatileTabsBySession } from "../browser/session-tab-process-state.js";
import {
  browserSessionTabStorageKey,
  parseBrowserSessionTabRecord,
} from "../browser/session-tab-store.js";
import { runBrowserProxyCommand } from "../node-host/invoke-browser.js";
import {
  requireEntry,
  type SessionTabsTestFixture,
} from "./browser-request.session-tabs.test-support.js";

export async function runSessionTabNodeScenarios(h: SessionTabsTestFixture) {
  const { fixture, state, generations, tabs, closed, handler, withNativeClosePreparation } = h;
  const profileRuntime = state.profiles.get("openclaw");
  if (profileRuntime) {
    profileRuntime.running = null;
  }
  setRuntimeConfigSnapshot({
    gateway: {
      nodes: { browser: { mode: "auto" }, commands: { allow: ["browser.proxy"] } },
    },
    browser: {
      defaultProfile: "openclaw",
      profiles: { openclaw: { cdpPort: 18800, color: "#FF4500" } },
    },
  });
  const node: NodeSession = {
    nodeId: "node-1",
    connId: "node-connection",
    connectedAtMs: 1,
    declaredCaps: ["browser"],
    declaredCommands: ["browser.proxy"],
    declaredNodePluginTools: [],
    nodePluginTools: [],
    nodeSkills: [],
    client: {
      connId: "node-connection",
      usesSharedGatewayAuth: false,
      connect: {
        minProtocol: 3,
        maxProtocol: 3,
        role: "node",
        client: { id: "node-host", mode: "node", platform: "linux", version: "test" },
      },
      socket: {
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn(),
        close: vi.fn(),
        terminate: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
      },
    },
    caps: ["browser"],
    commands: ["browser.proxy"],
    platform: "linux",
  };
  type Invoke = Parameters<GatewayRequestHandlers[string]>[0]["context"]["nodeRegistry"]["invoke"];
  const nativeInvoke: Invoke = async ({ params, command, signal }) => ({
    ok: true,
    payloadJSON: await runBrowserProxyCommand(JSON.stringify(params), command, signal),
  });
  fixture.nodeGatewayCall.mockImplementation(async (_method, _options, envelope, options) =>
    nativeInvoke({ ...envelope, signal: options?.signal }),
  );
  const nodeRequest = async (key: string, invoke: Invoke) => {
    const respond = vi.fn();
    await handler({
      req: { type: "req", id: "node-lifetime", method: "browser.request" },
      params: {
        target: "node",
        node: "node-1",
        sessionKey: key,
        method: "POST",
        path: "/tabs/open",
        body: { url: "about:blank" },
      },
      context: await createTestGatewayRequestContext({
        nodeRegistry: { listConnected: () => [node], invoke },
      }),
      client: null,
      respond,
      isWebchatConnect: () => false,
    });
    return respond.mock.calls[0]!;
  };
  const retire = (key: string) => {
    generations.set(key, "retired-" + generations.get(key));
    for (const borrow of fixture.borrows) {
      if (borrow.sessionKey === key) {
        borrow.controller.abort(new Error("Session replaced"));
      }
    }
  };
  // The node owns the durable row; Gateway adoption must only add a volatile route.
  const successfulKey = "agent:main:node-success";
  generations.set(successfulKey, "node-success-generation");
  const successfulScope = await prepareBrowserSessionScope(successfulKey);
  const store = getBrowserStateRuntime().sessionTabDiscovery;
  let nativeRows: Awaited<ReturnType<typeof store.entries>> = [];
  let nativeOpened: unknown;
  const successfulTarget = "native-" + (h.nextId + 1);
  const successful = await nodeRequest(successfulKey, async (args) => {
    const result = await nativeInvoke(args);
    if (!result.payloadJSON) {
      throw new Error("Node response missing");
    }
    nativeOpened = JSON.parse(result.payloadJSON).result;
    nativeRows = await store.entries();
    expect(
      nativeRows.some(
        ({ value }) => parseBrowserSessionTabRecord(value)?.nativeTargetId === successfulTarget,
      ),
    ).toBe(true);
    return result;
  });
  expect(successful[0], JSON.stringify(successful)).toBe(true);
  expect(await store.entries()).toEqual(nativeRows);
  expect([...(volatileTabsBySession().get(successfulKey)?.values() ?? [])]).toEqual([
    expect.objectContaining({
      targetId: successfulTarget,
      route: expect.objectContaining({ kind: "node-proxy", nodeId: node.nodeId }),
      ownership: expect.objectContaining({ status: "durable" }),
    }),
  ]);
  const allocatedCleanup = captureBrowserNodeOpenCleanup({
    method: "POST",
    path: "/tabs/open",
    result: nativeOpened,
    session: successfulScope.session,
    route: createBrowserNodeSessionTabRoute(node),
  });
  if (!allocatedCleanup) {
    throw new Error("Allocated cleanup capability missing");
  }
  allocatedCleanup.rememberAssociation();
  await allocatedCleanup.cleanup();
  expect(tabs.some((tab) => tab.id === successfulTarget)).toBe(false);
  expect(
    (await store.entries()).some(
      ({ value }) => parseBrowserSessionTabRecord(value)?.nativeTargetId === successfulTarget,
    ),
  ).toBe(false);
  expect(volatileTabsBySession().get(successfulKey)?.size ?? 0).toBe(0);

  const nodeLeafKey = "agent:main:node-leaf-takeover";
  generations.set(nodeLeafKey, "node-leaf-generation");
  const nodeLeafScope = await prepareBrowserSessionScope(nodeLeafKey);
  const nodeLeafTarget = "native-" + (h.nextId + 1);
  await withNativeClosePreparation(nodeLeafTarget, async (ownership, entered, proceed) => {
    vi.mocked(cdpHelpers.resolveCdpTabOwnership).mockResolvedValueOnce(ownership);
    expect((await nodeRequest(nodeLeafKey, nativeInvoke))[0]).toBe(true);
    const saved = (await store.entries()).find(
      ({ value }) => parseBrowserSessionTabRecord(value)?.nativeTargetId === nodeLeafTarget,
    );
    const record = parseBrowserSessionTabRecord(saved?.value);
    if (!saved || !record) {
      throw new Error("Node allocation missing");
    }
    const closing = createBrowserNodeSessionTabRoute(node).closeTarget({
      targetId: nodeLeafTarget,
      profile: "openclaw",
      ownership,
      session: nodeLeafScope.session,
    });
    await requireEntry(entered, closing);
    const claimed = {
      ...record,
      sessionKey: "agent:main:node-leaf-dashboard",
      dashboard: {
        name: "node-leaf",
        sessionKey: "agent:main:node-leaf-dashboard",
        instanceId: "node-leaf-instance",
        url: "about:blank",
        state: "active" as const,
      },
    };
    const claimKey = browserSessionTabStorageKey(claimed);
    await store.register(claimKey, claimed);
    proceed();
    expect(await closing).toEqual({ status: "cancelled" });
    expect(tabs.some((tab) => tab.id === nodeLeafTarget)).toBe(true);
    expect(await store.lookup(claimKey)).toEqual(claimed);
    expect(await store.lookup(saved.key)).toEqual(record);
    await store.delete(claimKey);
    await store.delete(saved.key);
    volatileTabsBySession().delete(nodeLeafKey);
    tabs.splice(
      tabs.findIndex((tab) => tab.id === nodeLeafTarget),
      1,
    );
  });
  const cancelKey = "agent:main:node-cancel";
  generations.set(cancelKey, "node-before-dispatch");
  const entered = createDeferred<void>();
  const proceed = createDeferred<void>();
  const before = h.nextId;
  const pending = nodeRequest(cancelKey, async (args) => {
    entered.resolve();
    await proceed.promise;
    return await nativeInvoke(args);
  });
  await requireEntry(entered.promise, pending);
  retire(cancelKey);
  proceed.resolve();
  expect((await pending)[0]).toBe(false);
  expect(h.nextId).toBe(before);
  expect(
    fixture.borrows.find((borrow) => borrow.sessionKey === cancelKey)?.release,
  ).toHaveBeenCalledOnce();

  const toolKey = "agent:main:node-tool-cancel";
  generations.set(toolKey, "tool-before-dispatch");
  const toolEntered = createDeferred<void>();
  const toolProceed = createDeferred<void>();
  fixture.nodeGatewayCall.mockImplementationOnce(async (_method, _options, envelope, options) => {
    toolEntered.resolve();
    await toolProceed.promise;
    return await nativeInvoke({ ...envelope, signal: options?.signal });
  });
  const proxy = createBrowserNodeProxyRequest({
    nodeTarget: node,
    allowAutomaticHostFallback: false,
  });
  const toolPending = withBrowserRequestScope(await prepareBrowserSessionScope(toolKey), () =>
    proxy({ method: "POST", path: "/tabs/open", body: { url: "about:blank" } }),
  );
  const toolDenied = expect(toolPending).rejects.toThrow("Session replaced");
  await requireEntry(toolEntered.promise, toolPending);
  retire(toolKey);
  toolProceed.resolve();
  await toolDenied;
  expect(h.nextId).toBe(before);
  expect(
    fixture.borrows.find((borrow) => borrow.sessionKey === toolKey)?.release,
  ).toHaveBeenCalledOnce();

  // Success comes from the actual node dispatcher; reset only after native allocation completes.
  const lateKey = "agent:main:node-late-open";
  generations.set(lateKey, "node-before-response");
  const created = "native-" + (h.nextId + 1);
  const late = await nodeRequest(lateKey, async (args) => {
    const result = await nativeInvoke(args);
    retire(lateKey);
    return result;
  });
  expect(late[0]).toBe(false);
  expect(closed).toContain(created);
  expect(tabs.some((tab) => tab.id === created)).toBe(false);
  expect(
    (await getBrowserStateRuntime().sessionTabDiscovery.entries()).some(
      ({ value }) => parseBrowserSessionTabRecord(value)?.nativeTargetId === created,
    ),
  ).toBe(false);

  const fileKey = "agent:main:node-file-failure";
  generations.set(fileKey, "file-before-response");
  const fileCreated = "native-" + (h.nextId + 1);
  const persistence = vi
    .spyOn(proxyFiles, "persistBrowserProxyResultFiles")
    .mockRejectedValueOnce(new Error("file persistence unavailable"));
  const failedFiles = await nodeRequest(fileKey, nativeInvoke);
  expect(failedFiles[0]).toBe(false);
  expect(failedFiles[2].message).toContain("file persistence unavailable");
  expect(tabs.some((tab) => tab.id === fileCreated)).toBe(false);
  expect(
    (await store.entries()).some(
      ({ value }) => parseBrowserSessionTabRecord(value)?.nativeTargetId === fileCreated,
    ),
  ).toBe(false);
  persistence.mockRestore();
  const toolLateKey = "agent:main:tool-late-open";
  generations.set(toolLateKey, "tool-before-response");
  const toolCreated = "native-" + (h.nextId + 1);
  fixture.nodeGatewayCall.mockImplementationOnce(async (_method, _options, envelope, options) => {
    const result = await nativeInvoke({ ...envelope, signal: options?.signal });
    retire(toolLateKey);
    return result;
  });
  await expect(
    withBrowserRequestScope(await prepareBrowserSessionScope(toolLateKey), () =>
      proxy({ method: "POST", path: "/tabs/open", body: { url: "about:blank" } }),
    ),
  ).rejects.toThrow("Session replaced");
  expect(tabs.some((tab) => tab.id === toolCreated)).toBe(false);
  expect(
    (await store.entries()).some(
      ({ value }) => parseBrowserSessionTabRecord(value)?.nativeTargetId === toolCreated,
    ),
  ).toBe(false);

  // A native creation that settles after dispatch cancellation must clean up on the node.
  const nativeOpen = vi.mocked(cdp.createTargetViaCdp).getMockImplementation();
  if (!nativeOpen) {
    throw new Error("Native open fixture missing");
  }
  const nativeEntered = createDeferred<void>();
  const nativeProceed = createDeferred<void>();
  vi.mocked(cdp.createTargetViaCdp).mockImplementationOnce(async (...args) => {
    const opened = await nativeOpen(...args);
    nativeEntered.resolve();
    await nativeProceed.promise;
    return opened;
  });
  const lateNativeKey = "agent:main:node-native-cancel";
  generations.set(lateNativeKey, "native-before-reset");
  const nativeCreated = "native-" + (h.nextId + 1);
  const lateNative = nodeRequest(lateNativeKey, nativeInvoke);
  await requireEntry(nativeEntered.promise, lateNative);
  retire(lateNativeKey);
  nativeProceed.resolve();
  expect((await lateNative)[0]).toBe(false);
  expect(tabs.some((tab) => tab.id === nativeCreated)).toBe(false);
  expect(
    (await store.entries()).some(
      ({ value }) => parseBrowserSessionTabRecord(value)?.nativeTargetId === nativeCreated,
    ),
  ).toBe(false);
}
