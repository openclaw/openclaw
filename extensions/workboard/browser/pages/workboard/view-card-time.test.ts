import { expectDefined } from "@openclaw/normalization-core";
import { render } from "@solidjs/web";
import { createComponent, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../../test/host.setup.ts";
import { CardUpdatedTime } from "./view-card-content.tsx";

let container: HTMLDivElement;
let visibility: DocumentVisibilityState;
let dispose = () => {};
let documentLanguage: string;
const now = 1_800_000_000_000;

beforeEach(() => {
  documentLanguage = document.documentElement.lang;
  document.documentElement.lang = "de";
  vi.useFakeTimers();
  vi.setSystemTime(now);
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  dispose();
  container.remove();
  document.documentElement.lang = documentLanguage;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("shares one scheduled timer across 300 cards without replacing focused controls", async () => {
  function ClockFixture() {
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Draft");
    input.value = "Keep editing";
    return [
      input,
      ...Array.from({ length: 300 }, (_, index) =>
        createComponent(CardUpdatedTime, { updatedAt: now - (index % 2 ? 20_000 : 10_000), now }),
      ),
    ];
  }
  const scheduled = vi.spyOn(globalThis, "setTimeout");
  dispose = render(() => createComponent(ClockFixture, {}), container);
  flush();
  await Promise.resolve();
  expect(scheduled).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  const input = expectDefined(container.querySelector("input"), "focused draft input");
  input.focus();
  input.setSelectionRange(2, 5);
  const times = container.querySelectorAll("time");
  expect(times).toHaveLength(300);
  const first = expectDefined(times[0], "first card timestamp");
  const second = expectDefined(times[1], "second card timestamp");
  expect(first.textContent).toBe("just now");
  vi.advanceTimersByTime(40_000);
  flush();
  await Promise.resolve();
  expect(first.textContent).toBe("just now");
  expect(second.textContent).toBe("1m ago");
  vi.advanceTimersByTime(10_000);
  flush();
  await Promise.resolve();
  expect(first.textContent).toBe("1m ago");
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(2);
  expect(input.selectionEnd).toBe(5);
  dispose();
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(60_000);
  expect(first.textContent).toBe("1m ago");
  dispose = render(() => createComponent(ClockFixture, {}), container);
  flush();
  await Promise.resolve();
  expect(container.querySelector("time")?.textContent).toBe("2m ago");
  dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("pauses hidden-page clocks and catches up when the page becomes visible", async () => {
  dispose = render(() => createComponent(CardUpdatedTime, { updatedAt: now, now }), container);
  flush();
  await Promise.resolve();
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(120_000);
  flush();
  expect(container.querySelector("time")?.textContent).toBe("just now");
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  flush();
  await Promise.resolve();
  expect(container.querySelector("time")?.textContent).toBe("2m ago");
  expect(vi.getTimerCount()).toBe(1);
});
