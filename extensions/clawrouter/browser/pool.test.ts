import type {
  ControlUiHost,
  ControlUiPage,
  ControlUiViewContext,
} from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { flush } from "solid-js";
import { assert, expect, it, onTestFinished, vi } from "vitest";
import type { ClawRouterPoolResult } from "../pool.ts";
import plugin from "../src/control-ui.tsx";

async function fixture() {
  const abort = new AbortController();
  const listeners = new Set<() => void>();
  const request = vi.fn<ControlUiHost["request"]>();
  const first = createDeferred<ClawRouterPoolResult>();
  request.mockReturnValueOnce(first.promise);
  const connection = {
    connected: true,
    canRead: true,
    canWrite: false,
    canGrant: false,
    canAdmin: false,
    assistantAgentId: "main",
  };
  const unused = () => assert.fail("The pool view only reads its own Gateway method");
  let page!: ControlUiPage;
  const host: ControlUiHost = {
    apiVersion: 1,
    pluginId: "clawrouter",
    signal: abort.signal,
    basePath: "",
    locale: "en",
    redact: (text) => text.replaceAll("fixture-private", "[redacted]"),
    connection,
    // Vitest's mock wrapper erases the SDK request method's generic return type.
    request: request as ControlUiHost["request"],
    onEvent: unused,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sessions: {
      rows: [],
      selectedKey: "main",
      normalizeKey: unused,
      refresh: unused,
      observe: unused,
      open: unused,
      create: unused,
      patch: unused,
    },
    agents: {
      rows: [],
      selectedId: null,
      defaultId: null,
      scopeId: null,
      select: unused,
      setScope: unused,
      refresh: unused,
    },
    navigation: { openPage: unused, pageHref: unused },
    components: {
      resolveAppearanceColor: unused,
      mountDialog: unused,
      mountAgentPicker: unused,
      mountSelectPicker: unused,
      mountAgentAvatar: unused,
      mountAppearancePicker: unused,
      mountAppearanceGlyph: unused,
      mountSessionSummary: unused,
      mountDashboard: unused,
    },
    ui: {
      invalidate: unused,
      registerPage: (entry) => {
        page = entry;
        return () => undefined;
      },
      registerNavigation: () => () => undefined,
      pinNavigation: unused,
      unpinNavigation: unused,
      isNavigationPinned: unused,
      registerPanel: unused,
      openPanel: unused,
      registerAction: unused,
      registerAccessory: unused,
      registerWidget: unused,
      registerInlineView: unused,
      registerReplacement: unused,
      selectReplacement: unused,
    },
  };
  const stop = await plugin.activate(host);
  const container = document.body.appendChild(document.createElement("div"));
  let context: ControlUiViewContext = {
    host,
    signal: abort.signal,
    props: {},
    presented: true,
    mountDefault: () => () => undefined,
  };
  const mounted = page.mount(container, context) ?? assert.fail("The pool page did not mount");
  onTestFinished(() => {
    mounted.dispose?.();
    if (typeof stop === "function") {
      stop();
    }
    abort.abort();
    container.remove();
  });
  flush();
  return {
    container,
    connection,
    first,
    request,
    button: container.querySelector<HTMLButtonElement>("button") ?? assert.fail("No refresh"),
    update(presented: boolean) {
      context = { ...context, presented };
      mounted.update?.(context);
      flush();
    },
    notify() {
      for (const listener of listeners) {
        listener();
      }
      flush();
    },
  };
}

const pool: ClawRouterPoolResult = {
  status: "ok",
  pool: {
    version: "clawrouter.pool.v1",
    models: ["fixture-model"],
    grants: [],
    usage: { lanes: [], grants: [] },
  },
};

it("retains accepted pool content through refresh failure and clears the alert during retry", async () => {
  const f = await fixture();
  expect(f.button.disabled).toBe(true);
  expect(f.container.textContent).toContain("Loading the latest pool status");
  f.first.resolve(pool);
  await vi.waitFor(() => expect(f.button.disabled).toBe(false));
  expect(f.container.textContent).toContain("fixture-model");
  const content = f.container.querySelector(".clawrouter-pool__summary");
  const failed = createDeferred<ClawRouterPoolResult>();
  f.request.mockReturnValueOnce(failed.promise);
  f.button.click();
  f.button.click();
  flush();
  expect(f.request).toHaveBeenCalledTimes(2);
  expect(f.container.querySelector(".clawrouter-pool__summary")).toBe(content);
  expect(f.button.disabled).toBe(true);
  failed.reject(new Error("fixture-private is unavailable"));
  await vi.waitFor(() =>
    expect(f.container.querySelector('[role="alert"]')?.textContent).toBe(
      "[redacted] is unavailable",
    ),
  );
  expect(f.container.querySelector(".clawrouter-pool__summary")).toBe(content);
  const retry = createDeferred<ClawRouterPoolResult>();
  f.request.mockReturnValueOnce(retry.promise);
  f.button.click();
  await vi.waitFor(() => expect(f.container.querySelector('[role="alert"]')).toBeNull());
  expect(f.button.disabled).toBe(true);
  expect(f.container.querySelector(".clawrouter-pool__summary")).toBe(content);
  retry.resolve({ status: "not_configured", message: "Configure the provider to view its pool." });
  await vi.waitFor(() => expect(f.button.disabled).toBe(false));
  expect(f.container.textContent).toContain("Configure the provider to view its pool.");
  expect(f.container.querySelector(".clawrouter-pool__summary")).toBeNull();
});

it("retires reads when hidden or access changes without publishing their late result", async () => {
  const f = await fixture();
  f.update(false);
  const current = createDeferred<ClawRouterPoolResult>();
  f.request.mockReturnValueOnce(current.promise);
  f.update(true);
  expect(f.request).toHaveBeenCalledTimes(2);
  f.first.reject(new Error("retired request"));
  current.resolve(pool);
  await vi.waitFor(() => expect(f.container.textContent).toContain("fixture-model"));
  expect(f.container.querySelector('[role="alert"]')).toBeNull();
  f.connection.canRead = false;
  f.notify();
  expect(f.container.textContent).toContain("Read access is required");
  expect(f.container.querySelector(".clawrouter-pool__summary")).toBeNull();
  expect(f.button.disabled).toBe(true);
});

it("matches grant traffic by provider and key suffix and updates totals after refresh", async () => {
  const f = await fixture();
  const result: ClawRouterPoolResult = {
    status: "ok",
    pool: {
      version: "clawrouter.pool.v1",
      models: [],
      grants: [
        { key: "subscription/shared", provider: "alpha", windows: [], eligibility: {} },
        { key: "oauth/shared", provider: "beta", windows: [], eligibility: {} },
      ],
      usage: {
        lanes: [],
        grants: [
          {
            provider: "alpha",
            grantKey: "shared",
            requests: 2,
            inputTokens: 20,
            outputTokens: 4,
            cacheReadTokens: 1,
            cacheWriteTokens: 3,
            costMicros: 1_000_000,
          },
          {
            provider: "alpha",
            grantKey: "shared",
            requests: 3,
            inputTokens: 30,
            outputTokens: 6,
            cacheReadTokens: 2,
            cacheWriteTokens: 4,
            costMicros: 2_000_000,
          },
          {
            provider: "beta",
            grantKey: "shared",
            requests: 17,
            inputTokens: 170,
            outputTokens: 34,
            cacheReadTokens: 8,
            cacheWriteTokens: 9,
            costMicros: 7_000_000,
          },
          { provider: "alpha", grantKey: "other", requests: 99, costMicros: 99_000_000 },
        ],
      },
    },
  };
  const trafficValues = () =>
    Array.from(f.container.querySelectorAll(".clawrouter-pool__grant"), (grant) =>
      Array.from(
        grant.querySelectorAll(".clawrouter-pool__traffic dd"),
        (value) => value.textContent,
      ),
    );
  f.first.resolve(result);
  await vi.waitFor(() =>
    expect(trafficValues()).toEqual([
      ["5", "50", "10", "3", "7", "$3.00"],
      ["17", "170", "34", "8", "9", "$7.00"],
    ]),
  );

  const refreshed = structuredClone(result);
  refreshed.pool.usage.grants[0]!.requests = 8;
  refreshed.pool.usage.grants[0]!.costMicros = 4_000_000;
  f.request.mockResolvedValueOnce(refreshed);
  f.button.click();
  await vi.waitFor(() =>
    expect(trafficValues()).toEqual([
      ["11", "50", "10", "3", "7", "$6.00"],
      ["17", "170", "34", "8", "9", "$7.00"],
    ]),
  );
});
