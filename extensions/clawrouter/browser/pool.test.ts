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
    get sessions() {
      return unused();
    },
    get agents() {
      return unused();
    },
    get navigation() {
      return unused();
    },
    get components() {
      return unused();
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
  const context: ControlUiViewContext = {
    host,
    signal: abort.signal,
    props: {},
    presented: true,
    mountDefault: () => () => undefined,
  };
  const mounted = page.mount(container, context) ?? assert.fail("The pool page did not mount");
  onTestFinished(() => {
    mounted.dispose?.();
    if (stop) {
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
    summary: () => container.querySelector(".clawrouter-pool__summary"),
    alert: () => container.querySelector('[role="alert"]'),
    update(presented: boolean) {
      mounted.update?.({ ...context, presented });
      flush();
    },
    notify() {
      listeners.forEach((listener) => listener());
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
  const content = f.summary();
  const failed = createDeferred<ClawRouterPoolResult>();
  f.request.mockReturnValueOnce(failed.promise);
  f.button.click();
  f.button.click();
  flush();
  expect(f.request).toHaveBeenCalledTimes(2);
  expect(f.summary()).toBe(content);
  expect(f.button.disabled).toBe(true);
  failed.reject(new Error("fixture-private is unavailable"));
  await vi.waitFor(() => expect(f.alert()?.textContent).toBe("[redacted] is unavailable"));
  expect(f.summary()).toBe(content);
  const retry = createDeferred<ClawRouterPoolResult>();
  f.request.mockReturnValueOnce(retry.promise);
  f.button.click();
  await vi.waitFor(() => expect(f.alert()).toBeNull());
  expect(f.summary()).toBe(content);
  retry.resolve({ status: "not_configured", message: "Configure the provider to view its pool." });
  await vi.waitFor(() =>
    expect(f.container.textContent).toContain("Configure the provider to view its pool."),
  );
  expect(f.summary()).toBeNull();
});

it("retires reads when hidden or access changes without publishing their late result", async () => {
  const f = await fixture();
  f.update(false);
  const current = createDeferred<ClawRouterPoolResult>();
  f.request.mockReturnValueOnce(current.promise);
  f.update(true);
  f.first.reject(new Error("retired request"));
  current.resolve(pool);
  await vi.waitFor(() => expect(f.container.textContent).toContain("fixture-model"));
  expect(f.alert()).toBeNull();
  f.connection.canRead = false;
  f.notify();
  expect(f.container.textContent).toContain("Read access is required");
  expect(f.summary()).toBeNull();
  expect(f.button.disabled).toBe(true);
});

it("matches grant traffic by provider and key suffix and updates totals after refresh", async () => {
  const f = await fixture();
  const result = structuredClone(pool);
  result.pool.models = [];
  result.pool.grants = [
    { key: "subscription/shared", provider: "alpha", windows: [], eligibility: {} },
    { key: "oauth/shared", provider: "beta", windows: [], eligibility: {} },
  ];
  result.pool.usage.grants = [
    traffic("alpha", 2, 1, 3, 1),
    traffic("alpha", 3, 2, 4, 2),
    traffic("beta", 17, 8, 9, 7),
    { provider: "alpha", grantKey: "other", requests: 99, costMicros: 99_000_000 },
  ];
  const cells = ".clawrouter-pool__traffic dd";
  const expectTraffic = (...rows: string[]) =>
    vi.waitFor(() =>
      expect(
        Array.from(f.container.querySelectorAll(".clawrouter-pool__grant"), (grant) =>
          Array.from(grant.querySelectorAll(cells), (v) => v.textContent).join("|"),
        ),
      ).toEqual(rows),
    );
  f.first.resolve(result);
  await expectTraffic("5|50|10|3|7|$3.00", "17|170|34|8|9|$7.00");

  const refreshed = structuredClone(result);
  refreshed.pool.usage.grants[0]!.requests = 8;
  refreshed.pool.usage.grants[0]!.costMicros = 4_000_000;
  f.request.mockResolvedValueOnce(refreshed);
  f.button.click();
  await expectTraffic("11|50|10|3|7|$6.00", "17|170|34|8|9|$7.00");
});

function traffic(provider: string, requests: number, read: number, write: number, usd: number) {
  return {
    provider,
    grantKey: "shared",
    requests,
    inputTokens: requests * 10,
    outputTokens: requests * 2,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    costMicros: usd * 1_000_000,
  };
}
