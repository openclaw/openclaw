import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkboardTestHost } from "../../test/host.ts";
import type { WorkboardCard } from "../workboard/types.ts";
import { createFeedStore } from "./feed-store.ts";

const NOW = new Date(2026, 9, 14, 10, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;

function card(id: string, snoozedUntil?: number): WorkboardCard {
  return {
    id,
    title: id,
    status: "todo",
    priority: "normal",
    labels: [],
    position: 1,
    createdAt: NOW - 5 * HOUR,
    updatedAt: NOW - 5 * HOUR,
    ...(snoozedUntil ? { metadata: { feed: { snoozedUntil } } } : {}),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("feed store", () => {
  it("republishes when a snooze ends so the page and the nav badge show the card again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fixture = createWorkboardTestHost();
    fixture.connection.connected = true;
    fixture.host.request = vi.fn(async () => ({
      cards: [card("open"), card("snoozed", NOW + HOUR)],
    })) as ControlUiHost["request"];
    const store = createFeedStore(fixture.host);
    await store.refresh();
    expect(store.openCount()).toBe(1);
    expect(store.view().snoozed.map((item) => item.card.id)).toEqual(["snoozed"]);

    const listener = vi.fn();
    store.subscribe(listener);
    vi.advanceTimersByTime(HOUR - 1);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.openCount()).toBe(2);
    expect(store.view().open[0]).toMatchObject({ card: { id: "snoozed" }, woke: true });
    store.dispose();
    fixture.dispose();
  });
});
