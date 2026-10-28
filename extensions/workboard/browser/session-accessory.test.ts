import "./test/dom.setup.ts";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { expect, it, onTestFinished, vi } from "vitest";
import { createWorkboardCard } from "./lib/workboard/test/index-helpers.ts";
import { mountPage } from "./pages/workboard/workboard-page.test-support.ts";
import { createWorkboardSessionAccessory } from "./session-accessory.tsx";
import { workboardTestHost } from "./test/host.setup.ts";
import { createViewContext } from "./test/host.ts";

function mountAccessory(sessionKey: string, payload: unknown = {}, agentId?: string) {
  const fixture = workboardTestHost();
  fixture.connection.connected = true;
  const request = vi.fn(async (method: string) =>
    method === "workboard.cards.list" ? payload : { tasks: [] },
  );
  fixture.host.request = request as typeof fixture.host.request;
  const container = document.body.appendChild(document.createElement("div"));
  const context = createViewContext(fixture.host, { sessionKey, ...(agentId ? { agentId } : {}) });
  let mounted = createWorkboardSessionAccessory()(container, context);
  const dispose = () => {
    mounted?.dispose?.();
    mounted = undefined;
  };
  onTestFinished(dispose);
  return { ...fixture, request, container, context, mounted, dispose };
}

it("reveals a reassigned linked card without changing the selected chat agent", async () => {
  const sessionKey = "agent:writer:dashboard:1";
  const card = createWorkboardCard({
    agentId: "main",
    sessionKey,
    metadata: { automation: { boardId: "ops" } },
  });
  const payload = { cards: [card], boards: [{ id: "ops" }] };
  const { host, container } = mountAccessory(sessionKey, payload);
  Object.assign(host.agents, { selectedId: "writer", scopeId: "writer" });
  let destination: HTMLElement | undefined;
  vi.mocked(host.navigation.openPage).mockImplementation(({ path }) => {
    const page = mountPage({ boardId: path?.[0] ?? "__all__", connected: true });
    page.cards([card]);
    destination = page.container;
  });
  await vi.waitFor(() => expect(container.textContent).toContain(card.title));
  container.querySelector("a")!.click();
  await vi.waitFor(() =>
    expect(destination?.querySelector(".workboard-board")?.textContent).toContain(card.title),
  );
  expect(host.agents).toMatchObject({ scopeId: null, selectedId: "writer" });
});

it.each(["global", "unknown"])("ignores bare %s sessions despite an ambient owner", (key) => {
  const { container, host } = mountAccessory(key, {}, "writer");
  expect(container.querySelector("a")).toBeNull();
  expect(host.navigation.openPage).not.toHaveBeenCalled();
});

it("refreshes only the visible session and ignores stale lookups after navigation", async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const initialListeners = new Set(workboardTestHost().listeners);
  const sessionKey = "agent:main:workboard-card";
  const card = createWorkboardCard({ status: "review", sessionKey });
  const revision = { epoch: "test", revision: 1 };
  const fixture = mountAccessory(sessionKey, { cards: [card], revision });
  const { container, context, mounted, dispose, request, listeners } = fixture;
  await vi.advanceTimersByTimeAsync(0);
  expect(container.textContent).toContain(card.title);
  fixture.emit("plugin.workboard.changed", { ...revision, revision: 2, cardsRevision: 1 });
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledOnce();
  request.mockResolvedValueOnce({
    cards: [{ ...card, title: "Renamed" }],
    revision: { ...revision, revision: 3 },
  });
  fixture.emit("plugin.workboard.changed", { ...revision, revision: 3, cardsRevision: 3 });
  await vi.advanceTimersByTimeAsync(0);
  expect(container.textContent).toContain("Renamed");
  expect(request).toHaveBeenLastCalledWith("workboard.cards.list", {
    sessionKey,
    sinceRevision: { ...revision, sessionKey },
  });
  const pending = createDeferred<unknown>();
  request.mockReturnValueOnce(pending.promise);
  mounted?.update?.({ ...context, props: { sessionKey: "agent:main:other" } });
  mounted?.update?.({ ...context, presented: false });
  pending.resolve({ cards: [card] });
  await vi.advanceTimersByTimeAsync(0);
  expect(container.querySelector("a")).toBeNull();
  const count = request.mock.calls.length;
  fixture.emit("plugin.workboard.changed", { ...revision, revision: 4 });
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(count);
  dispose();
  expect(container.childElementCount).toBe(0);
  expect(listeners).toEqual(initialListeners);
});
