/* @vitest-environment jsdom */

import type * as UI from "openclaw/plugin-sdk/control-ui";
import { expect, it, onTestFinished, vi } from "vitest";
import plugin from "./control-ui.js";

// Knowledge answers for the default agent's ready store.
const answers: Record<string, unknown> = {
  stores_snapshot: { defaultAgent: "main", agents: [], stores: [] },
  status: { agent: "main", vault: "vault-1", scope: "private", store: "ready", snapshot: "s1" },
  ontology: {
    view: "catalog",
    nextOffset: null,
    definitions: [{ name: "person", label: "Person", primitive: "entity", recordCount: 410 }],
  },
  recent: { items: [], upperSequence: 0, nextBefore: null },
  records: { records: [], total: 0, offset: 0, nextOffset: null },
};

// Mounts the page on a fake host. Each `held` answer ("scribes" is the Scribes count's job
// list) waits until the test releases it; each `failing` action is refused.
function mount(held: string[] = [], failing: string[] = []) {
  const calls: string[] = [];
  const gates = new Map(held.map((name) => [name, Promise.withResolvers<void>()]));
  const request = vi.fn(async (method: string, params?: { actionId?: string }) => {
    const name = method === "cron.list" ? "scribes" : (params?.actionId ?? method);
    calls.push(name);
    await gates.get(name)?.promise;
    gates.delete(name);
    if (method !== "plugins.sessionAction") {
      return method === "cron.list" ? { jobs: [] } : { sessions: [] };
    }
    return name in answers && !failing.includes(name)
      ? { ok: true, result: answers[name] }
      : { ok: false, error: `${name} failed` };
  });
  const registerPage = vi.fn<(page: UI.ControlUiPage) => () => void>(() => () => {});
  const controller = new AbortController();
  const host = {
    pluginId: "knowledge",
    signal: controller.signal,
    connection: { connected: true, canRead: true, canWrite: false },
    redact: (text: string) => text,
    request,
    onEvent: () => () => {},
    subscribe: () => () => {},
    agents: { rows: [{ id: "main", name: "Main" }], selectedId: "main" },
    navigation: { openPage: vi.fn() },
    ui: { registerPage, registerNavigation: () => () => {}, registerPanel: () => () => {} },
  } as unknown as UI.ControlUiHost;
  void plugin.activate(host);
  const view = registerPage.mock.calls[0]![0].mount(document.body, {
    host,
    props: {},
    signal: controller.signal,
    presented: true,
    mountDefault: () => () => {},
  });
  onTestFinished(() => {
    controller.abort();
    view?.dispose?.();
    document.body.replaceChildren();
  });
  const release = (name: string) => gates.get(name)?.resolve();
  return { calls, release, gates };
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const tab = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".knowledge-tab")].find((node) =>
    node.textContent!.startsWith(name),
  )!;
const shows = (text: string) =>
  vi.waitFor(() => expect($(".knowledge-content")!.textContent).toContain(text));

it("checks status beside store facts and shows both tab counts at once", async () => {
  const { calls, release } = mount(["stores_snapshot", "status", "scribes"]);
  await vi.waitFor(() => expect(calls.toSorted()).toEqual(["status", "stores_snapshot"]));
  expect($(".knowledge-status")!.hidden).toBe(true);
  expect($(".knowledge-copy-pending")).not.toBeNull();
  release("stores_snapshot");
  release("status");
  await shows("No recent activity");
  expect(calls.filter((call) => call === "status")).toHaveLength(1);
  expect($(".knowledge-copy-pending")).toBeNull();
  expect(tab("Browse").querySelector(".knowledge-tab-count-pending")).not.toBeNull();
  release("scribes");
  await vi.waitFor(() => expect(tab("Browse").textContent).toBe("Browse410"));
  expect($(".knowledge-tab-count-pending")).toBeNull();
});

it("shows a tab's last view again while it refreshes on return", async () => {
  const { gates } = mount();
  await shows("No recent activity");
  tab("Browse").click();
  await shows("Nothing here yet");
  gates.set("recent", Promise.withResolvers<void>());
  tab("Recent").click();
  expect($(".knowledge-content")!.textContent).toContain("No recent activity");
  expect($(".knowledge-view-data")!.inert).toBe(true);
  gates.get("recent")!.resolve();
  await vi.waitFor(() => expect($(".knowledge-view-data")!.inert).toBe(false));
});

it("keeps a failed page total out of the view's outcome", async () => {
  mount([], ["ontology"]);
  await shows("No recent activity");
  await vi.waitFor(() => expect($(".knowledge-tab-count-pending")).toBeNull());
  expect($(".knowledge-status")!.hidden).toBe(true);
  expect($(".knowledge-error")).toBeNull();
});

it("gives Browse its page types before the Scribes count arrives", async () => {
  mount(["scribes"]);
  await shows("No recent activity");
  tab("Browse").click();
  await shows("Nothing here yet");
  expect($('[data-facet="person"]')).not.toBeNull();
});
