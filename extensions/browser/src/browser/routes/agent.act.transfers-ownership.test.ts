import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { useBrowserDashboardTestHarness } from "../../browser-dashboard.test-harness.js";
import type { BrowserTab } from "../client.types.js";
import type { ResolvedBrowserProfile } from "../config.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
  setPwToolsCoreDownloadCapture,
} from "../pw-tools-core.test-harness.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import { makeBrowserProfile, makeBrowserServerState } from "../server-context.test-harness.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const browser = vi.hoisted(() => ({
  open: vi.fn(),
  tabs: vi.fn(),
  ownership: vi.fn(),
  closeOwned: vi.fn(),
}));
const preparation = vi.hoisted(() => ({ paths: vi.fn(), module: vi.fn(), output: vi.fn() }));
vi.mock("../client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client.js")>()),
  browserOpenTab: browser.open,
  browserTabs: browser.tabs,
}));
vi.mock("../cdp.helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cdp.helpers.js")>()),
  resolveCdpTabOwnership: browser.ownership,
  closeTrackedCdpTarget: browser.closeOwned,
}));
vi.mock("../paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../paths.js")>()),
  resolveExistingUploadPaths: async ({ requestedPaths }: { requestedPaths: string[] }) => {
    await preparation.paths();
    return { ok: true, paths: requestedPaths };
  },
  resolveStrictExistingUploadPaths: async ({ requestedPaths }: { requestedPaths: string[] }) => ({
    ok: true,
    paths: requestedPaths,
  }),
}));
vi.mock("./output-paths.js", () => ({
  ensureOutputRootDir: async () => await preparation.output(),
  resolveWritableOutputPathOrRespond: async ({ requestedPath }: { requestedPath: string }) =>
    requestedPath,
}));
vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: async () => {
    await preparation.module();
    return {
      ...(await import("../pw-tools-core.interactions.content.js")),
      ...(await import("../pw-tools-core.downloads.js")),
    };
  },
}));

import {
  assertBrowserDashboardTargetCurrent,
  reconcileBrowserDashboards,
  requestBrowserDashboard,
  stopBrowserDashboard,
} from "../../browser-dashboard.js";
import { registerBrowserAgentActDownloadRoutes } from "./agent.act.download.js";
import { registerBrowserAgentActHookRoutes } from "./agent.act.hooks.js";

installPwToolsCoreTestHooks();
const sessionKey = "agent:main:dashboard-transfer-proof";
const request = { sessionKey, agentId: "main", name: "service" };

function transferRoutes(tab: BrowserTab) {
  const profile = makeBrowserProfile();
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected profile operation");
  };
  const profileCtx: ProfileContext = {
    profile,
    ensureBrowserAvailable: async () => {},
    ensureTabAvailable: async () => tab,
    isHttpReachable: async () => true,
    isTransportAvailable: async () => true,
    isReachable: async () => true,
    listTabs: async () => [tab],
    openTab: unused,
    labelTab: unused,
    focusTab: unused,
    closeTab: unused,
    stopRunningBrowser: unused,
    resetProfile: unused,
  };
  const state = makeBrowserServerState({ profile, resolvedOverrides: { ssrfPolicy: undefined } });
  const context: BrowserRouteContext = {
    ...profileCtx,
    state: () => state,
    forProfile: () => profileCtx,
    listProfiles: unused,
    mapTabError: () => null,
  };
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentActHookRoutes(app, context);
  registerBrowserAgentActDownloadRoutes(app, context);
  return postHandlers;
}

const cases = [
  {
    kind: "input",
    path: "/hooks/file-chooser",
    body: { inputRef: "1", paths: ["/tmp/upload.txt"] },
    preparation: "paths",
  },
  {
    kind: "upload",
    path: "/hooks/file-chooser",
    body: { ref: "1", paths: ["/tmp/upload.txt"] },
    preparation: "paths",
  },
  {
    kind: "upload arm",
    path: "/hooks/file-chooser",
    body: { paths: ["/tmp/upload.txt"] },
    preparation: "paths",
  },
  { kind: "dialog arm", path: "/hooks/dialog", body: { accept: true }, preparation: "module" },
  {
    kind: "download",
    path: "/download",
    body: { ref: "1", path: "/tmp/download.txt" },
    preparation: "output",
  },
  {
    kind: "download waiter",
    path: "/wait/download",
    body: { path: "/tmp/download.txt" },
    preparation: "output",
  },
] as const;

describe("dashboard transfer authority", () => {
  const fixture = useBrowserDashboardTestHarness(browser, sessionKey);
  it.each(
    cases.flatMap((entry) =>
      ["Stop", "replacement", "current", "absent"].map((authority) =>
        Object.assign({}, entry, { authority }),
      ),
    ),
  )(
    "checks $kind authority after $authority during preparation",
    async ({ kind, path, body, preparation: gate, authority }) => {
      for (const prepare of Object.values(preparation)) {
        prepare.mockResolvedValue(undefined);
      }
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      preparation[gate].mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
      });
      const dashboard = await requestBrowserDashboard(request);
      const targetId = dashboard.browserTab!.targetId;
      const tab: BrowserTab = { targetId, type: "page", title: "Service", url: dashboard.url };
      const nativeEffect = vi.fn(async () => {});
      const fileChooser = { setFiles: nativeEffect };
      const waitForEvent = vi.fn(async () => fileChooser);
      setPwToolsCoreCurrentPage({ url: () => tab.url, isClosed: () => false, waitForEvent });
      setPwToolsCoreCurrentRefLocator({ setInputFiles: nativeEffect, click: nativeEffect });
      const session = getPwToolsCoreSessionMocks();
      session.armObservedDialogResponseOnPage.mockImplementation(() => {
        void nativeEffect();
      });
      const capture = {
        armed: true,
        promise: Promise.resolve({
          url: tab.url,
          path: "/tmp/download.txt",
          suggestedFilename: "download.txt",
        }),
        cancel: vi.fn(),
      };
      setPwToolsCoreDownloadCapture(capture);
      const closeEntered = createDeferred<void>();
      const releaseClose = createDeferred<void>();
      browser.closeOwned.mockImplementation(async () => {
        closeEntered.resolve();
        await releaseClose.promise;
        fixture.tabs = fixture.tabs.filter((entry) => entry.targetId !== targetId);
        return { status: "closed" };
      });
      const response = createBrowserRouteResponse();
      const operation = Promise.resolve(
        transferRoutes(tab).get(path)!(
          {
            params: {},
            query: {},
            body: { ...body, targetId },
            ...(authority === "absent"
              ? {}
              : {
                  assertCurrent: async (profile?: ResolvedBrowserProfile) =>
                    await assertBrowserDashboardTargetCurrent(dashboard, "main", {}, profile),
                }),
          },
          response.res,
        ),
      );
      let retirement: Promise<unknown> | undefined;
      try {
        await Promise.race([
          entered.promise,
          operation.then(() => {
            throw new Error(
              `Transfer ended before preparation: ${response.statusCode} ${JSON.stringify(response.body)}`,
            );
          }),
        ]);
        if (authority === "Stop" || authority === "replacement") {
          if (authority === "replacement") {
            fixture.widgets[0]!.instanceId = "instance-two";
            retirement = reconcileBrowserDashboards();
          } else {
            retirement = stopBrowserDashboard(request);
          }
          await Promise.race([
            closeEntered.promise,
            retirement.then(() => {
              throw new Error("Retirement skipped held close");
            }),
          ]);
        }
        expect(fixture.tabs.map((entry) => entry.targetId)).toContain(targetId);
        release.resolve();
        await operation;
        if (authority === "Stop" || authority === "replacement") {
          expect(nativeEffect).not.toHaveBeenCalled();
          expect(waitForEvent).not.toHaveBeenCalled();
          expect(response.statusCode).toBeGreaterThanOrEqual(400);
          expect(response.body).toMatchObject({ error: expect.stringMatching(/dashboard/i) });
        } else {
          expect(response.statusCode).toBe(200);
          if (kind !== "download waiter") {
            await vi.waitFor(() => expect(nativeEffect).toHaveBeenCalled());
          }
          expect(response.body).toMatchObject({ ok: true });
        }
      } finally {
        release.resolve();
        releaseClose.resolve();
        await Promise.allSettled([operation, retirement]);
      }
    },
  );
});
