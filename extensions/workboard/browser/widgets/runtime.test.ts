import "../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import type { ControlUiHost, ControlUiWidget } from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getWorkboardState } from "../lib/workboard/runtime.ts";
import { createWorkboardCard } from "../lib/workboard/test/index-helpers.ts";
import type { WorkboardCard } from "../lib/workboard/types.ts";
import { workboardTestHost } from "../test/host.setup.ts";
import { createViewContext } from "../test/host.ts";
import { afterWorkboardUpdate as settle } from "../test/settle.ts";
import { createWorkboardWidget } from "../widgets.tsx";
import { acquireWidgetRuntime } from "./runtime.ts";

const cards = (["ready", "running", "done"] as const).map((status, index) =>
  createWorkboardCard({
    id: status,
    title: `${status.charAt(0).toUpperCase()}${status.slice(1)} card`,
    status,
    position: (index + 1) * 1000,
    ...(index === 0 ? { agentId: "agent-a" } : {}),
    metadata: { automation: { boardId: "ops" } },
  }),
);
const movedCard = () => createWorkboardCard({ ...cards[0], status: "running", position: 3000 });
const moveParams = { id: "ready", status: "running", position: 3000 };
const moveError = "Move temporarily unavailable";
const snapshot = (listedCards: WorkboardCard[] = cards) => ({
  cards: listedCards,
  statuses: ["ready", "running", "done"],
});
const disposers: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
  vi.useRealTimers();
});

function setup(
  request = vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => snapshot()),
) {
  const fixture = workboardTestHost();
  fixture.connection.connected = true;
  fixture.host.request = request as ControlUiHost["request"];
  const mount = (
    kind: "mini" | "card" | "board",
    props: Record<string, unknown>,
    canMutate = true,
  ) => {
    const abort = new AbortController();
    const scopedRequest = vi.fn((method: string, params?: unknown) => request(method, params));
    const scopedHost = {
      ...fixture.host,
      signal: abort.signal,
      request: scopedRequest as ControlUiHost["request"],
    };
    const container = document.createElement("div");
    document.body.append(container);
    const context = createViewContext(scopedHost, {
      sessionKey: "main",
      widget: { name: kind, props },
      canMutate,
      canGrant: true,
    });
    const mounted = createWorkboardWidget(fixture.host, kind)(container, context) as Exclude<
      ReturnType<ControlUiWidget["mount"]>,
      void
    >;
    flush();
    const dispose = () => {
      abort.abort();
      mounted.dispose?.();
    };
    disposers.push(dispose);
    return {
      container,
      query: <E extends Element = HTMLElement>(selector: string) =>
        container.querySelector<E>(selector),
      get select() {
        return container.querySelector("select");
      },
      texts: (selector: string) =>
        [...container.querySelectorAll(selector)].map((el) => el.textContent),
      get text() {
        return container.textContent;
      },
      scopedRequest,
      signal: abort.signal,
      dispose,
      setPresented: (presented: boolean) => {
        mounted.update?.({ ...context, presented });
        flush();
      },
    };
  };
  const lease = () => {
    const acquired = acquireWidgetRuntime(fixture.host, () => {});
    disposers.push(() => acquired.release());
    return acquired.runtime;
  };
  const reconnect = () => {
    fixture.connection.connected = false;
    fixture.notify();
    fixture.connection.connected = true;
    fixture.notify();
  };
  return { fixture, request, mount, lease, reconnect };
}

type Widget = ReturnType<ReturnType<typeof setup>["mount"]>;
function setupMove(move: () => unknown, list: () => unknown = snapshot) {
  return setup(
    vi.fn(async (method: string) => (method === "workboard.cards.move" ? move() : list())),
  );
}
const expectLoaded = (widget: Widget) => settle(() => expect(widget.select).not.toBeNull());
const expectStatus = (widget: Widget, value: string) =>
  settle(() => expect(widget.select?.value).toBe(value));
function expectText(widgets: Widget[], text: string, present = true) {
  for (const widget of widgets) {
    const assertion = expect(widget.text);
    (present ? assertion : assertion.not).toContain(text);
  }
}

function changeStatus(container: HTMLElement, status = "running") {
  const select = container.querySelector("select")!;
  select.value = status;
  select.dispatchEvent(new Event("change"));
}

it("discloses incomplete widget data and loads an absent card on demand for read-only viewers", async () => {
  const first = expectDefined(cards[0], "first card");
  const cursor = { id: first.id, position: first.position, createdAt: first.createdAt };
  const request = vi.fn(async (_method: string, params?: unknown) => {
    // SAFETY: this fixture receives the cards-list request contract.
    const input = params as { after?: unknown };
    return input.after
      ? snapshot(cards.slice(1))
      : { ...snapshot(cards.slice(0, 1)), nextCursor: cursor };
  });
  const { mount } = setup(request);
  const mini = mount("mini", {}, false);
  const card = mount("card", { cardId: "running" }, false);
  const widgets = [mini, card, mount("board", {}, false)];
  await settle(() => {
    expectText(widgets, "Counts and results include loaded cards only");
    expect(card.text).toContain("This card is not loaded yet");
    expect(card.text).not.toContain("no longer available");
  });
  card.query<HTMLButtonElement>("button")!.click();
  await settle(() => {
    expect(card.text).toContain("Running card");
    expectText(widgets, "Load more cards", false);
  });
  expect(request).toHaveBeenLastCalledWith("workboard.cards.list", { after: cursor });
});

it.each([false, true])(
  "shows connection loss without claiming cards disappeared (previously loaded: %s)",
  async (previouslyLoaded) => {
    const reconnected = createDeferred<unknown>();
    const request = vi.fn(async () => reconnected.promise);
    if (previouslyLoaded) {
      request.mockResolvedValueOnce(snapshot());
    }
    const { fixture, mount } = setup(request);
    fixture.connection.connected = previouslyLoaded;
    const widgets = [mount("mini", {}), mount("card", { cardId: "ready" }), mount("board", {})];
    if (previouslyLoaded) {
      await settle(() => expectText(widgets, "Ready card"));
      fixture.connection.connected = false;
      fixture.notify();
      flush();
    }

    for (const widget of widgets) {
      expect(widget.query('[role="status"]')?.textContent).toContain(
        "Connect to the Gateway to load Workboard.",
      );
      expect(widget.text).not.toContain("no longer available");
      expect(widget.select).toBeNull();
      expect(widget.query("[data-test-id]")).toBeNull();
    }
    expect(request).toHaveBeenCalledTimes(previouslyLoaded ? 1 : 0);

    fixture.connection.connected = true;
    fixture.notify();
    flush();
    expectText(widgets, "Loading Workboard");
    reconnected.resolve(snapshot());
    await settle(() => {
      for (const widget of widgets) {
        expect(widget.text).toContain("Ready card");
        expect(widget.query('[role="status"]')).toBeNull();
      }
    });
    expect(request).toHaveBeenCalledTimes(previouslyLoaded ? 2 : 1);
  },
);

it("shares reads across distinct scoped hosts and releases the subscription with the last widget", async () => {
  const { fixture, request, mount } = setup();
  const mini = mount("mini", { boardId: "ops" });
  const card = mount("card", { cardId: "ready" });
  await settle(() => {
    expect(mini.text).toContain("Running card");
    expect(card.text).toContain("Ready card");
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(mini.scopedRequest).not.toHaveBeenCalled();
  expect(fixture.events.get("plugin.workboard.changed")?.size).toBe(1);
  mini.dispose();
  expect(fixture.events.get("plugin.workboard.changed")?.size).toBe(1);
  card.dispose();
  expect(fixture.events.get("plugin.workboard.changed")?.size).toBe(0);
});

it("deduplicates moves across widgets while issuing the mutation through the invoking view", async () => {
  const move = createDeferred<unknown>();
  const { mount, request } = setupMove(() => move.promise);
  const first = mount("card", { cardId: "ready" });
  const second = mount("card", { cardId: "ready" });
  await expectLoaded(second);
  changeStatus(first.container);
  changeStatus(second.container);
  expect(request.mock.calls.filter(([method]) => method === "workboard.cards.move")).toHaveLength(
    1,
  );
  expect(first.scopedRequest).toHaveBeenCalledWith("workboard.cards.move", moveParams);
  expect(second.scopedRequest).not.toHaveBeenCalled();
  move.resolve({ card: movedCard() });
  await expectStatus(second, "running");
});

it("recovers every shared widget after a failed move when the operator retries", async () => {
  const move = vi
    .fn()
    .mockRejectedValueOnce(new Error(moveError))
    .mockResolvedValueOnce({ card: movedCard() });
  const { mount } = setupMove(move);
  const card = mount("card", { cardId: "ready" });
  const mini = mount("mini", {});
  const board = mount("board", {});
  const widgets = [card, mini, board];
  await expectLoaded(card);
  changeStatus(card.container);
  await settle(() => expectText(widgets, moveError));

  mini.query<HTMLButtonElement>("button")!.click();
  await settle(() => {
    for (const widget of widgets) {
      expect(widget.text).toContain("Ready card");
      expect(widget.query('[role="alert"]')).toBeNull();
    }
  });
  changeStatus(card.container);
  await expectStatus(card, "running");
  expect(move).toHaveBeenCalledTimes(2);
});

it.each([
  { refreshDuringMove: false, refreshFails: false },
  { refreshDuringMove: true, refreshFails: false },
  { refreshDuringMove: false, refreshFails: true },
  { refreshDuringMove: true, refreshFails: true },
])(
  "keeps a newer mutation failure visible (refresh during move: $refreshDuringMove, refresh fails: $refreshFails)",
  async ({ refreshDuringMove, refreshFails }) => {
    const refreshed = createDeferred<unknown>();
    const reconciled = createDeferred<unknown>();
    const move = createDeferred<unknown>();
    let persistedCards = cards;
    let listCount = 0;
    const { mount, request, lease } = setup(
      vi.fn(async (method: string) => {
        if (method === "workboard.cards.move") {
          return move.promise;
        }
        if (method === "workboard.cards.list") {
          return ++listCount === 2 ? refreshed.promise : snapshot(persistedCards);
        }
        return { tasks: [] };
      }),
    );
    const card = mount("card", { cardId: "ready" });
    await expectLoaded(card);
    // Recovery uses the invoking view's host; shared refreshes retain their own response.
    card.scopedRequest.mockImplementation((method, params) =>
      method === "workboard.cards.list" ? reconciled.promise : request(method, params),
    );
    const runtime = lease();
    const refresh = refreshDuringMove ? null : runtime.refresh();
    changeStatus(card.container);
    const duringMoveRefresh = refreshDuringMove ? runtime.refresh() : null;
    persistedCards = [movedCard(), ...cards.slice(1)];
    move.reject(new Error(moveError));
    await settle(() => expect(card.scopedRequest).toHaveBeenCalledWith("workboard.cards.list", {}));
    expect(card.text).toContain(moveError);
    expect(getWorkboardState(runtime.owner).mutationReadiness).toBe("canonical_reload_required");
    if (refreshFails) {
      refreshed.reject(new Error("List temporarily unavailable"));
    } else {
      refreshed.resolve(snapshot());
    }
    await Promise.all([refresh, duringMoveRefresh]);
    expect(card.text).toContain(moveError);
    expect(card.select).toBeNull();

    reconciled.resolve(snapshot(persistedCards));
    await settle(() => expect(getWorkboardState(runtime.owner).mutationReadiness).toBe("ready"));
    expect(card.text).toContain(moveError);
    expect(card.select).toBeNull();
    card.query<HTMLButtonElement>("button")!.click();
    await expectStatus(card, "running");
    expect(card.query('[role="alert"]')).toBeNull();
    expect(listCount).toBe(3);
  },
);

it.each([false, true])(
  "preserves an acknowledged card move across shared widgets (refresh during move: %s)",
  async (refreshDuringMove) => {
    const refreshed = createDeferred<void>();
    const move = createDeferred<unknown>();
    let persistedCards = cards;
    let listCount = 0;
    const { request, mount, lease } = setupMove(
      () => move.promise,
      async () => {
        const listed = snapshot(persistedCards);
        if (++listCount > 1) {
          await refreshed.promise;
        }
        return listed;
      },
    );
    const card = mount("card", { cardId: "ready" });
    const board = mount("board", {});
    const mini = mount("mini", {});
    await expectLoaded(card);
    const runtime = lease();
    const refresh = refreshDuringMove ? null : runtime.refresh();

    changeStatus(card.container);
    expect(request).toHaveBeenLastCalledWith("workboard.cards.move", moveParams);
    const duringMoveRefresh = refreshDuringMove ? runtime.refresh() : null;
    const moved = movedCard();
    persistedCards = [...cards.slice(1), moved];
    move.resolve({ card: moved });
    const expectAcknowledgedMove = () => {
      expect(card.select?.value).toBe("running");
      expect(board.texts(".workboard-column--running .workboard-card h3")).toEqual([
        "Running card",
        "Ready card",
      ]);
      expect(mini.texts(".workboard-widget-mini__card strong")).toEqual([
        "Running card",
        "Ready card",
      ]);
    };
    await settle(expectAcknowledgedMove);
    await settle(() => expect(listCount).toBe(2));

    refreshed.resolve();
    await Promise.all([refresh, duringMoveRefresh]);
    await settle(() => expect(runtime.loading).toBe(false));
    expectAcknowledgedMove();
  },
);

it.each(["success", "failure"] as const)(
  "refreshes every widget after a change during an older pending list (%s)",
  async (outcome) => {
    const firstList = createDeferred<unknown>();
    const request = vi.fn(async () =>
      request.mock.calls.length === 1 ? firstList.promise : snapshot(),
    );
    const { fixture, mount } = setup(request);
    const mini = mount("mini", {});
    const card = mount("card", { cardId: "ready" });
    fixture.emit("plugin.workboard.changed", {});
    if (outcome === "success") {
      firstList.resolve(snapshot([]));
    } else {
      firstList.reject(new Error("List temporarily unavailable"));
    }
    await settle(() => {
      expect(request).toHaveBeenCalledTimes(2);
      expect(mini.text).toContain("Ready card");
      expect(card.text).toContain("Ready card");
    });
  },
);

it("preserves a current queued refresh when an older connection completes", async () => {
  const oldList = createDeferred<unknown>();
  const currentList = createDeferred<unknown>();
  const request = vi.fn(async () =>
    request.mock.calls.length === 1
      ? oldList.promise
      : request.mock.calls.length === 2
        ? currentList.promise
        : snapshot(),
  );
  const { fixture, mount, reconnect } = setup(request);
  const widget = mount("mini", {});
  reconnect();
  fixture.emit("plugin.workboard.changed", {});
  oldList.resolve(snapshot([]));
  await oldList.promise;
  currentList.resolve(snapshot([]));
  await settle(() => {
    expect(request).toHaveBeenCalledTimes(3);
    expect(widget.text).toContain("Running card");
  });
});

it("ignores a completed move from the previous connection", async () => {
  const move = createDeferred<unknown>();
  let current = false;
  const { fixture, mount } = setupMove(
    () => move.promise,
    () => snapshot(current ? [{ ...cards[0]!, title: "Current card" }] : cards),
  );
  const widget = mount("card", { cardId: "ready" });
  await expectLoaded(widget);
  changeStatus(widget.container);
  fixture.connection.connected = false;
  fixture.notify();
  current = true;
  fixture.connection.connected = true;
  fixture.notify();
  await settle(() => expect(widget.text).toContain("Current card"));
  move.resolve({ card: { ...cards[0], title: "Stale card", status: "running" } });
  await move.promise;
  await Promise.resolve();
  expect(widget.text).toContain("Current card");
  expect(widget.text).not.toContain("Stale card");
  expect(widget.select?.value).toBe("ready");
});

it.each([
  { kind: "card", input: "status" },
  { kind: "board", input: "status" },
  { kind: "board", input: "drop" },
] as const)(
  "fences retained hidden $kind $input controls while a visible peer retains the shared runtime",
  async ({ kind, input }) => {
    const { fixture, request, mount } = setupMove(() => ({ card: movedCard() }));
    const hidden = mount(kind, kind === "card" ? { cardId: "ready" } : { boardId: "ops" });
    const visible = mount("mini", {});
    await settle(() => expect(visible.text).toContain("Ready card"));
    let move = () => changeStatus(hidden.container);
    if (input === "drop") {
      const card = hidden.query(".workboard-card");
      const column = hidden.query(".workboard-column--running");
      if (!card || !column) {
        throw new Error("The board widget must render its card and destination column.");
      }
      card.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
      move = () => {
        column.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
      };
    }

    hidden.setPresented(false);
    expect(hidden.signal.aborted).toBe(false);
    expect(fixture.events.get("plugin.workboard.changed")?.size).toBe(1);
    move();
    expect(hidden.scopedRequest).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);

    hidden.setPresented(true);
    expect(hidden.text).toContain("Ready card");
    expect(hidden.select?.disabled).toBe(false);
    if (input === "drop") {
      const card = hidden.query(".workboard-card");
      if (!card) {
        throw new Error("The presented board must render its draggable card.");
      }
      // The rejected hidden drop consumes the original drag; start a new gesture.
      card.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    }
    move();
    expect(hidden.scopedRequest).toHaveBeenCalledExactlyOnceWith(
      "workboard.cards.move",
      moveParams,
    );
    await settle(() =>
      expect(
        hidden.query<HTMLSelectElement>('select[aria-label="Status: Ready card"]')?.value,
      ).toBe("running"),
    );
  },
);

it.each(["mini", "board"] as const)(
  "scopes %s to an explicit board and excludes archived cards",
  async (kind) => {
    const other = {
      ...cards[0]!,
      id: "other",
      title: "Other card",
      metadata: { automation: { boardId: "product" } },
    };
    const archived = {
      ...cards[1]!,
      id: "archived",
      title: "Archived card",
      metadata: { automation: { boardId: "ops" }, archivedAt: 10 },
    };
    const { mount } = setup(vi.fn(async () => snapshot([...cards, other, archived])));
    const scoped = mount(kind, { boardId: "ops" });
    const all = mount(kind, {});
    await settle(() => expect(all.text).toContain("Other card"));
    expect(scoped.text).toContain("Ready card");
    expect(scoped.text).not.toContain("Other card");
    expect(all.text).not.toContain("Archived card");
    if (kind === "mini") {
      const counts = [
        ...scoped.container.querySelectorAll(".workboard-widget-mini__counts span"),
      ].map((entry) => entry.textContent?.replace(/\s+/g, " ").trim());
      expect(counts).toEqual(expect.arrayContaining(["1 Ready", "1 Running", "1 Done"]));
      expect(scoped.query("a")?.getAttribute("href")).toBe("/workboard/ops");
      expect(all.query("a")?.getAttribute("href")).toBe("/workboard");
    } else {
      expect(scoped.container.querySelectorAll(".workboard-column")).toHaveLength(3);
      const product = mount("board", { boardId: "product" });
      await settle(() => expect(product.text).toContain("Other card"));
      expect(product.query(".workboard-column--running")?.textContent).toContain("No cards yet");
      expect(product.text).not.toContain("No cards match this view");
    }
  },
);

it("keeps every board control read-only", async () => {
  const { mount, request } = setup();
  const widget = mount("board", {}, false);
  await settle(() => expect(widget.container.querySelectorAll("select")).toHaveLength(3));
  expect([...widget.container.querySelectorAll("select")].every((select) => select.disabled)).toBe(
    true,
  );
  changeStatus(widget.container);
  expect(request).toHaveBeenCalledTimes(1);
});

it("skips session-only events, conditionally reloads cards, and fully reloads on reconnect", async () => {
  const revision = { epoch: "cards", revision: 1 };
  const request = vi.fn(async (_method: string, _params?: unknown) => ({
    ...snapshot(),
    boards: [],
    revision,
  }));
  const { fixture, lease, reconnect } = setup(request);
  const runtime = lease();
  await runtime.refresh();
  request.mockClear();
  fixture.emit("plugin.workboard.changed", { epoch: "cards", revision: 2, cardsRevision: 1 });
  expect(request).not.toHaveBeenCalled();
  await runtime.refresh();
  expect(request).toHaveBeenLastCalledWith("workboard.cards.list", { sinceRevision: revision });
  reconnect();
  await runtime.refresh();
  expect(request.mock.calls.some(([, params]) => JSON.stringify(params) === "{}")).toBe(true);
});
