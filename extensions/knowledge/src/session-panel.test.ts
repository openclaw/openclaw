/* @vitest-environment jsdom */
import type { ControlUiHost, ControlUiPanel } from "openclaw/plugin-sdk/control-ui";
import { expect, it, onTestFinished, vi } from "vitest";
import { registerSessionPanel } from "./session-panel.js";

function mountPanel() {
  const sessionKey = "agent:main:main";
  const detail = Promise.withResolvers<unknown>();
  const events = [3, 2, 1].map((sequence) => ({
    sequence,
    id: "notes",
    title: "Field notes",
    at: "2026-01-01T12:00:00Z",
    action: "read",
    operation: "record",
  }));
  const request = vi.fn(async (_method: string, params: { payload: { operation: string } }) => {
    switch (params.payload.operation) {
      case "status":
        return { ok: true, result: { store: "ready", vault: "test" } };
      case "session_activity":
        return { ok: true, result: { items: events, upper: 3, nextBefore: null } };
      case "record_detail":
        return { ok: true, result: await detail.promise };
      default:
        throw new Error("Unexpected operation");
    }
  });
  const registerPanel = vi.fn<(panel: ControlUiPanel) => () => void>(() => () => {});
  const onEvent = vi.fn<ControlUiHost["onEvent"]>(() => () => {});
  const controller = new AbortController();
  const host = {
    pluginId: "knowledge",
    signal: controller.signal,
    connection: { connected: true },
    sessions: {
      rows: [{ key: sessionKey, sessionId: "session", agentId: "main" }],
      normalizeKey: (key: string) => key,
    },
    navigation: { pageHref: () => "/plugin" },
    redact: (text: string) => text,
    request,
    onEvent,
    subscribe: () => () => {},
    ui: { registerPanel },
  } as unknown as ControlUiHost;
  registerSessionPanel(host);
  const view = registerPanel.mock.calls[0]![0].mount(document.body, {
    host,
    props: { sessionKey, agentId: "main" },
    signal: controller.signal,
    presented: true,
    mountDefault: () => () => {},
  });
  onTestFinished(() => {
    controller.abort();
    view?.dispose?.();
    document.body.replaceChildren();
  });
  return { detail, request, events, onEvent };
}
const cards = () => document.querySelectorAll<HTMLButtonElement>(".knowledge-session-card");
const preview = () => document.querySelector<HTMLElement>(".knowledge-session-preview")!;
const back = () => preview().querySelector<HTMLButtonElement>("button")!;

it("returns from an unavailable preview to the activity event that opened it, not the first matching record", async () => {
  const { detail } = mountPanel();
  await vi.waitFor(() => expect(cards()).toHaveLength(3));
  const origin = cards()[2]!;
  origin.focus();
  origin.click();
  detail.resolve({ record: null });
  await vi.waitFor(() => expect(preview().textContent).toContain("no longer available"));
  back().focus();
  back().click();
  expect(preview().hidden).toBe(true);
  expect(document.activeElement).toBe(origin);
});

it("offers Back while loading and does not reopen the preview after its late response", async () => {
  const { detail, request } = mountPanel();
  await vi.waitFor(() => expect(cards()).toHaveLength(3));
  const origin = cards()[1]!;
  origin.click();
  expect(back()).not.toBeNull();
  expect(document.activeElement).toBe(back());
  back().click();
  detail.resolve({
    record: { title: "Late notes", body: "sample" },
    content: { nextOffset: null },
  });
  await Promise.all(request.mock.results.map((result) => result.value));
  expect(preview().hidden).toBe(true);
  expect(preview().textContent).not.toContain("Late notes");
  expect(document.activeElement).toBe(origin);
});

it("keeps focus on the same event when an activity refresh inserts another read of the same record", async () => {
  const { events, onEvent } = mountPanel();
  await vi.waitFor(() => expect(cards()).toHaveLength(3));
  cards()[1]!.focus();
  events.unshift({ ...events[0]!, sequence: 4 });
  const changed = onEvent.mock.calls.find(([name]) => name === "plugin.knowledge.changed");
  expect(changed).toBeDefined();
  changed![1]({});
  await vi.waitFor(() => expect(cards()).toHaveLength(4), { timeout: 2000 });
  expect(document.activeElement).toBe(cards()[2]);
});
