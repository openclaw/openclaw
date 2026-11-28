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
  records_detail: { records: [], total: 0, offset: 0, nextOffset: null },
};

// Mounts the page on a fake host. Each `held` answer ("scribes" is the Scribes count's job
// list) waits until the test releases it; each `failing` action is refused.
function mount(
  held: string[] = [],
  failing: string[] = [],
  props: Record<string, string> = {},
  fixture?: {
    actions: Record<string, unknown>;
    page: { sessions: unknown[]; hasMore: boolean };
    roster: unknown[];
  },
) {
  const calls: string[] = [];
  const actionAnswers = { ...answers, ...fixture?.actions };
  const roster = vi.fn(() => fixture?.roster ?? []);
  const gates = new Map(held.map((name) => [name, Promise.withResolvers<void>()]));
  const request = vi.fn(
    async (method: string, params?: { actionId?: string; payload?: unknown; search?: string }) => {
      const name = method === "cron.list" ? "scribes" : (params?.actionId ?? method);
      calls.push(name);
      await gates.get(name)?.promise;
      gates.delete(name);
      if (method !== "plugins.sessionAction") {
        return method === "cron.list"
          ? { jobs: [] }
          : method === "sessions.list" && !params?.search && fixture
            ? fixture.page
            : { sessions: [] };
      }
      return name in actionAnswers && !failing.includes(name)
        ? { ok: true, result: actionAnswers[name] }
        : { ok: false, error: `${name} failed` };
    },
  );
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
    sessions: {
      get rows() {
        return roster();
      },
    },
    agents: { rows: [{ id: "main", name: "Main" }], selectedId: "main" },
    navigation: { openPage: vi.fn() },
    ui: { registerPage, registerNavigation: () => () => {}, registerPanel: () => () => {} },
  } as unknown as UI.ControlUiHost;
  void plugin.activate(host);
  const view = registerPage.mock.calls[0]![0].mount(document.body, {
    host,
    props,
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
  return { calls, release, gates, request, roster };
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const tab = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".knowledge-tab")].find((node) =>
    node.textContent!.startsWith(name),
  )!;
const shows = (text: string) =>
  vi.waitFor(() => expect($(".knowledge-content")!.textContent).toContain(text));

it.each([true, false])(
  "uses exact roster names only with a partial grant list (%s)",
  async (hasMore) => {
    const key = (name: string) => `agent:main:discord:channel:${name}`;
    const cold = key("100"),
      prefix = key("200"),
      missing = key("300"),
      current = key("400"),
      candidate = key("500");
    const grantKeys = [
      cold,
      prefix,
      missing,
      current,
      ...Array.from({ length: 496 }, (_, i) => key(`grant-${i}`)),
    ];
    const listed = {
      sessions: [
        { key: current, chatType: "channel", displayName: "Current channel name" },
        { key: prefix + ":thread:1", chatType: "channel", label: "Different thread" },
        { key: candidate, chatType: "channel", label: "New grant candidate" },
        { key: "agent:main:dashboard:unrelated", chatType: "direct" },
        ...Array.from({ length: 496 }, (_, i) => ({ key: key(`grant-${i}`), chatType: "channel" })),
      ],
      hasMore,
    };
    const { request, roster, calls } = mount(
      [],
      [],
      { view: "settings" },
      {
        actions: {
          stores_snapshot: {
            defaultAgent: "main",
            agents: [],
            stores: [],
            canChange: true,
            issues: [],
            grants: {
              revision: "a".repeat(64),
              entries: grantKeys.map((sessionKey) => ({
                sessionKey,
                agent: "main",
                access: "read",
              })),
            },
          },
          stores_grant: { outcome: "conflict", message: "Access changed" },
        },
        page: listed,
        roster: [
          { key: cold, chatType: "channel", displayName: "Operations room" },
          { key: current, chatType: "channel", label: "Old channel name" },
          {
            key: missing.replace("agent:main:", "agent:other:"),
            chatType: "channel",
            label: "Other agent",
          },
          { key: missing, chatType: "channel", derivedTitle: "Not a channel name" },
          { key: key("600"), chatType: "channel", label: "Not a picker candidate" },
        ],
      },
    );
    await shows("Conversation access");
    const panel = $(".knowledge-grants")!;
    const rows = [...panel.querySelectorAll("[role=listitem]")];
    expect(rows).toHaveLength(500);
    expect(rows.slice(0, 4).map((row) => row.querySelector("strong")?.textContent)).toEqual([
      hasMore ? "Operations room" : cold,
      prefix,
      missing,
      "Current channel name",
    ]);
    expect(rows[1]?.textContent).not.toContain("No known conversation");
    expect(rows[2]?.textContent?.includes("No known conversation")).toBe(!hasMore);
    expect(panel.textContent).not.toContain("Other agent");
    expect(rows[0]?.querySelector("small")?.textContent).toBe(hasMore ? cold : undefined);
    const picker = panel.querySelector<HTMLSelectElement>('select[aria-label="Conversation"]')!;
    expect([...picker.options].map(({ value }) => value)).toEqual(["", candidate]);
    expect(roster).toHaveBeenCalledTimes(hasMore ? 1 : 0);
    // Scribes uses separate search queries for its tab count, not for grant names.
    expect(
      request.mock.calls.filter(
        ([method, params]) =>
          method.startsWith("sessions.") &&
          !(method === "sessions.list" && params?.search?.startsWith("Scribe · ")),
      ),
    ).toEqual([["sessions.list", { agentId: "main", archived: "all", limit: 500 }]]);
    rows[0]?.querySelector("button")?.click();
    await vi.waitFor(() => expect(calls).toContain("stores_grant"));
    expect(
      request.mock.calls.find(([, params]) => params?.actionId === "stores_grant")?.[1]?.payload,
    ).toMatchObject({ sessionKey: cold, access: "none" });
  },
);

it("checks status beside store facts and shows both tab counts at once", async () => {
  const { calls, release, request } = mount(["stores_snapshot", "status", "scribes"]);
  await vi.waitFor(() => expect(calls.toSorted()).toEqual(["status", "stores_snapshot"]));
  expect(
    request.mock.calls.find(([, params]) => params?.actionId === "stores_snapshot")?.[1]?.payload,
  ).toEqual({ includeRecordCounts: false });
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

it.each([
  ["filter", "Project Orion"],
  ["type", "company"],
  ["origin", "agent_inference"],
])("distinguishes an empty filtered result from an empty store: %s", async (field, value) => {
  mount([], [], {
    view: "browse",
    [field]: value,
    ...(field === "origin" ? { kind: "claim" } : {}),
  });
  await shows("No matching records");
  expect($(".knowledge-content")!.textContent).toContain(
    "Try a different search or clear the filters.",
  );
  expect($(".knowledge-content")!.textContent).not.toContain("Tell your agent in chat");
});

it("ignores an inactive claim-origin filter when browsing pages", async () => {
  mount([], [], { view: "browse", origin: "agent_inference" });
  await shows("Nothing here yet");
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

it("lets Browse follow every returned page beyond offset 500", async () => {
  const { request } = mount();
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (method, params) => {
    if (method !== "plugins.sessionAction" || params?.actionId !== "records_detail") {
      return original(method, params);
    }
    const { offset = 0 } = params.payload as { offset?: number };
    const count = Math.min(50, 551 - offset);
    return {
      ok: true,
      result: {
        records: Array.from({ length: count }, (_, index) => ({
          id: `project_${offset + index}`,
          lifecycle: "active",
          title: `Fictional project ${offset + index}`,
          kind: "page",
          type: "project",
        })),
        total: 551,
        offset,
        nextOffset: offset + count < 551 ? offset + count : null,
      },
    };
  });
  await shows("No recent activity");
  tab("Browse").click();
  const next = () =>
    [...document.querySelectorAll<HTMLButtonElement>(".knowledge-pagination button")].find(
      (button) => button.textContent === "Next",
    )!;
  for (let offset = 0; offset <= 550; offset += 50) {
    await shows(`${offset + 1}–${Math.min(offset + 50, 551)} of 551`);
    expect(next().disabled).toBe(offset === 550);
    if (offset < 550) {
      next().click();
    }
  }
  expect($(".knowledge-content")!.textContent).toContain("Fictional project 550");
  expect($(".knowledge-pagination")!.textContent).toContain("complete list");
  expect($(".knowledge-content")!.textContent).not.toContain("cannot page beyond");
});
