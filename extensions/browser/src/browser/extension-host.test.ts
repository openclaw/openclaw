import { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { BrowserServerState, ProfileContext } from "./server-context.js";

const fixture = vi.hoisted(() => ({
  root: "",
  state: undefined as BrowserServerState | undefined,
  profile: undefined as ProfileContext | undefined,
}));
vi.mock("openclaw/plugin-sdk/text-utility-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/text-utility-runtime")>()),
  get CONFIG_DIR() {
    return fixture.root;
  },
}));
// mock-isolation: An isolated browser runtime replaces the live Gateway singleton.
vi.mock("../browser-control-state.js", () => ({
  getBrowserControlState: () => fixture.state,
  createBrowserControlContext: () => ({ forProfile: () => fixture.profile }),
}));
// mock-isolation: Registration must never start the operator's control service.
vi.mock("../control-service.js", () => ({
  startBrowserControlServiceFromConfig: async () => fixture.state,
}));

import * as cdp from "./cdp.helpers.js";
import * as chrome from "./chrome.js";
import { matchesExtensionBrowserEndpoint } from "./extension-host-state.js";
import { registerBrowserExtension } from "./extension-host.js";
import { extensionDeclarations } from "./extension-launch-state.js";
import { registerBrowserRoutes } from "./routes/index.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./routes/test-helpers.js";
import { stopBrowserRuntime } from "./runtime-lifecycle.js";
import * as screencasts from "./screencast/session.js";
import { createBrowserRouteContext, runProfileContextOperation } from "./server-context.js";
import { beginProfileTransition } from "./server-context.lifecycle.js";
import { makeBrowserServerState } from "./server-context.test-harness.js";

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-extension-host-"));
  fixture.root = root;
});
afterAll(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it("keeps worker arguments out of source, maps tabs, fences browser routes and closes retained capabilities", async () => {
  const id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await fs.writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      version: "8.12.46.6",
      background: { service_worker: "background.js" },
    }),
  );
  const state = makeBrowserServerState({ resolvedOverrides: { evaluateEnabled: true } });
  fixture.state = state;
  const context = createBrowserRouteContext({ getState: () => state });
  const profile = context.forProfile();
  fixture.profile = profile;
  state.resolved.profiles.alias = {
    color: "#123456",
    cdpUrl: "http://localhost:18800",
    driver: "existing-session",
  };
  const alias = context.forProfile("alias");
  expect(alias.profile.cdpPort).toBe(0);
  expect(matchesExtensionBrowserEndpoint(profile.profile, alias.profile.cdpUrl)).toBe(true);
  const runtime = state.profiles.get(profile.profile.name)!;
  const tab = {
    targetId: "target-1",
    url: "https://example.com/login",
    title: "Login",
    type: "page",
  };
  profile.ensureTabAvailable = async () => tab;
  profile.ensureBrowserAvailable = async () => {
    runtime.running ??= {
      pid: 12345678,
      exe: { kind: "chromium", path: "/synthetic/chromium" },
      userDataDir: root,
      cdpPort: 18800,
      proc: new ChildProcess(),
      extensionDeclaration: extensionDeclarations.get("openclaw"),
    };
  };
  profile.stopRunningBrowser = async () => {
    runtime.running = null;
    return { stopped: true };
  };
  vi.spyOn(chrome, "isChromeReachable").mockResolvedValue(false);
  vi.spyOn(chrome, "getChromeWebSocketEndpoint").mockResolvedValue({
    url: "ws://127.0.0.1:18800/devtools/browser/test",
  });
  const calls: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = [];
  let tabIds = [41];
  let disconnect = () => {};
  let destroyWorker = () => {};
  let replaceContext = () => {};
  let scriptLoaded = () => {};
  let runtimeEnabled = createDeferred<void>();
  vi.spyOn(cdp, "withCdpSocket").mockImplementation(async (_url, run, options) => {
    disconnect = () => options?.onClose?.();
    destroyWorker = () =>
      options?.onEvent?.({ method: "Target.targetDestroyed", params: { targetId: "worker-1" } });
    let contextId = 1;
    const emit = (method: string, params?: unknown) =>
      options?.onEvent?.({ method, params, sessionId: "worker-session" });
    const contextCreated = () =>
      emit("Runtime.executionContextCreated", {
        context: { id: contextId, origin: `chrome-extension://${id}/background.js`, name: "" },
      });
    scriptLoaded = () => emit("Inspector.workerScriptLoaded");
    replaceContext = () => {
      emit("Runtime.executionContextDestroyed", { executionContextId: contextId });
      contextId += 1;
      contextCreated();
      scriptLoaded();
    };
    return await run(async (method, params, sessionId) => {
      calls.push({ method, params, sessionId });
      if (method === "Target.getTargets") {
        return {
          targetInfos: [
            {
              type: "service_worker",
              targetId: "worker-1",
              url: `chrome-extension://${id}/background.js`,
            },
          ],
        };
      }
      if (method === "Target.attachToTarget") {
        return { sessionId: "worker-session" };
      }
      if (method === "Runtime.enable") {
        contextCreated();
        runtimeEnabled.resolve();
      }
      if (method === "Runtime.evaluate") {
        runtimeEnabled.resolve();
        return { result: { objectId: "worker-global" } };
      }
      if (method === "Runtime.callFunctionOn") {
        expect(params?.executionContextId).toBe(contextId);
        expect(params?.objectId).toBeUndefined();
        const source = String(params?.functionDeclaration);
        const fn = vm.runInNewContext(`(${source})`, {
          chrome: {
            tabs: { query: async () => tabIds.map((tabId) => ({ id: tabId, url: tab.url })) },
          },
        });
        const args = params?.arguments as Array<{ value: unknown }>;
        return { result: { value: await fn(args[0]?.value) } };
      }
      return {};
    });
  });
  const request = {
    profile: "openclaw",
    principal: "synthetic-person",
    extension: { id, unpackedPath: root, minimumVersion: "8.12.46.6" },
  };
  await expect(
    registerBrowserExtension({
      ...request,
      extension: { ...request.extension, minimumVersion: "8.12.46.7" },
    }),
  ).rejects.toThrow("older");
  const registration = await registerBrowserExtension(request);
  try {
    await expect(registerBrowserExtension(request)).rejects.toThrow("already owned");
    const opening = registration.openSession();
    let opened = false;
    void opening.then(() => {
      opened = true;
    });
    await runtimeEnabled.promise;
    expect(calls.some((call) => call.method === "Runtime.enable")).toBe(true);
    expect(opened).toBe(false);
    // A pre-script context is not ready; replacement before use is not worker loss.
    replaceContext();
    const session = await opening;
    expect(calls.some((call) => call.method === "Runtime.runIfWaitingForDebugger")).toBe(true);
    replaceContext();
    const secret = "synthetic-sensitive-argument";
    expect(
      await session.callInServiceWorker(
        (args: { token: string }) => ({ length: args.token.length }),
        { token: secret },
      ),
    ).toEqual({ length: secret.length });
    const invocation = calls.find((call) => call.method === "Runtime.callFunctionOn")!;
    expect(invocation.params?.functionDeclaration).not.toContain(secret);
    expect(invocation.params?.arguments).toEqual([{ value: { token: secret } }]);
    expect(invocation.sessionId).toBe("worker-session");
    expect(calls.some((call) => call.method === "Target.detachFromTarget")).toBe(false);
    expect(await session.resolveChromeTabId({ targetId: tab.targetId })).toBe(41);
    tabIds = [41, 42];
    await expect(session.resolveChromeTabId({ targetId: tab.targetId })).rejects.toThrow(
      "uniquely",
    );
    vi.spyOn(screencasts, "hasBrowserScreencast").mockReturnValueOnce(true);
    await expect(
      session.withExclusiveTab(tab, async () => "unsafe recording"),
    ).rejects.toMatchObject({
      code: "tabObserved",
      message: expect.stringContaining("Stop browser screencasts"),
    });
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const fill = session.withExclusiveTab(tab, async () => {
      entered.resolve();
      await release.promise;
      return "filled";
    });
    await entered.promise;
    await expect(
      runProfileContextOperation(alias, undefined, async () => "unsafe alias read"),
    ).rejects.toThrow("exclusive extension");
    const routes = createBrowserRouteApp();
    registerBrowserRoutes(routes.app, {
      state: () => state,
      forProfile: () => profile,
      listProfiles: async () => [],
    });
    for (const [method, route, body] of [
      ["get", "/snapshot", undefined],
      ["post", "/screenshot", { targetId: tab.targetId }],
      ["post", "/navigate", { targetId: tab.targetId, url: tab.url }],
      [
        "post",
        "/act",
        { kind: "evaluate", targetId: tab.targetId, fn: "() => document.body.innerText" },
      ],
    ] as const) {
      const response = createBrowserRouteResponse();
      const handler = (method === "get" ? routes.getHandlers : routes.postHandlers).get(route)!;
      await handler({ params: {}, query: { targetId: tab.targetId }, body }, response.res);
      expect(response.statusCode, route).toBe(409);
      expect(response.body).toMatchObject({
        error: expect.stringContaining("exclusive extension"),
      });
    }
    release.resolve();
    expect(await fill).toBe("filled");
    await expect(
      runProfileContextOperation(profile, undefined, async () => "read allowed"),
    ).resolves.toBe("read allowed");
    const reading = createDeferred<void>();
    const finishReading = createDeferred<void>();
    const reader = runProfileContextOperation(profile, undefined, async () => {
      reading.resolve();
      await finishReading.promise;
    });
    await reading.promise;
    await expect(session.withExclusiveTab(tab, async () => "unsafe overlap")).rejects.toThrow(
      "busy",
    );
    finishReading.resolve();
    await reader;
    await session.close();
    expect(calls.filter((call) => call.method === "Target.detachFromTarget")).toHaveLength(1);
    await expect(session.callInServiceWorker(() => true, null)).rejects.toThrow("closed");
    runtimeEnabled = createDeferred<void>();
    const openRunningSession = async (timeoutMs?: number) => {
      runtimeEnabled = createDeferred<void>();
      const runningSession = registration.openSession({ timeoutMs });
      await runtimeEnabled.promise;
      scriptLoaded();
      return await runningSession;
    };
    const staleSession = await openRunningSession();
    const selecting = createDeferred<void>();
    const finishSelection = createDeferred<void>();
    profile.ensureTabAvailable = async () => {
      selecting.resolve();
      await finishSelection.promise;
      return tab;
    };
    const staleCallback = vi.fn(async () => "must not run");
    const staleOperation = staleSession.withExclusiveTab(tab, staleCallback);
    const staleRejected = expect(staleOperation).rejects.toThrow("closed");
    await selecting.promise;
    await staleSession.close();
    finishSelection.resolve();
    await staleRejected;
    expect(staleCallback).not.toHaveBeenCalled();
    profile.ensureTabAvailable = async () => tab;
    for (const loss of ["socket", "worker", "context"] as const) {
      const lostSession = await openRunningSession();
      const waiting = createDeferred<void>();
      const finish = createDeferred<void>();
      const interrupted = lostSession.withExclusiveTab(tab, async () => {
        waiting.resolve();
        await finish.promise;
      });
      const rejected = expect(interrupted).rejects.toThrow("disconnected");
      await waiting.promise;
      (loss === "socket" ? disconnect : loss === "worker" ? destroyWorker : replaceContext)();
      await rejected;
      await expect(
        runProfileContextOperation(profile, undefined, async () => "unsafe read"),
      ).rejects.toThrow("quarantined");
      await expect(
        runProfileContextOperation(alias, undefined, async () => "unsafe alias read"),
      ).rejects.toThrow("quarantined");
      await profile.stopRunningBrowser();
      finish.resolve();
    }
    const timedSession = await openRunningSession(100);
    vi.useFakeTimers();
    try {
      const timeoutEntered = createDeferred<void>();
      const timedFill = timedSession.withExclusiveTab(tab, async () => {
        timeoutEntered.resolve();
        return await new Promise<never>(() => {});
      });
      const rejected = expect(timedFill).rejects.toThrow("timed out");
      await timeoutEntered.promise;
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      await expect(
        runProfileContextOperation(profile, undefined, async () => "unsafe read"),
      ).rejects.toThrow("quarantined");
      await profile.stopRunningBrowser();
      await expect(
        runProfileContextOperation(profile, undefined, async () => "safe stopped profile"),
      ).resolves.toBe("safe stopped profile");
    } finally {
      vi.useRealTimers();
    }
    const stop = profile.stopRunningBrowser;
    profile.stopRunningBrowser = vi
      .fn()
      .mockRejectedValueOnce(new Error("Synthetic cleanup failure"))
      .mockImplementation(stop);
    await expect(registration.close()).rejects.toThrow("Synthetic cleanup failure");
    expect(extensionDeclarations.has("openclaw")).toBe(true);
    await registration.close();
    expect(extensionDeclarations.has("openclaw")).toBe(false);
    const retiringRegistration = await registerBrowserExtension(request);
    await beginProfileTransition({
      state,
      runtime,
      reason: "synthetic profile deletion",
      terminal: "deleted",
      afterCleanup: async () => {
        state.profiles.delete("openclaw");
      },
    });
    expect(extensionDeclarations.has("openclaw")).toBe(false);
    fixture.profile = context.forProfile();
    const replacementRegistration = await registerBrowserExtension(request);
    const replacementDeclaration = extensionDeclarations.get("openclaw");
    await retiringRegistration.close();
    expect(extensionDeclarations.get("openclaw")).toBe(replacementDeclaration);
    await stopBrowserRuntime({
      current: state,
      clearState: () => {
        fixture.state = undefined;
      },
      onWarn: () => {},
    });
    expect(extensionDeclarations.has("openclaw")).toBe(false);
    await replacementRegistration.close();
  } finally {
    await registration.close();
  }
});
