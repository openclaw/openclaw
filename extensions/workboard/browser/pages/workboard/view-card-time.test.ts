import { expectDefined } from "@openclaw/normalization-core";
import { html, nothing, render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cardRelativeTime } from "./view-card-time.ts";

let container: HTMLDivElement;
let visibility: DocumentVisibilityState;
const now = 1_800_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  render(nothing, container);
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("updates idle card times at their boundaries without replacing focused controls", () => {
  const part = render(
    html`
      <input aria-label="Draft" value="Keep editing" />
      <time>${cardRelativeTime(now - 10_000, now)}</time>
      <time>${cardRelativeTime(now - 20_000, now)}</time>
    `,
    container,
  );
  expect(vi.getTimerCount()).toBe(1);
  const input = expectDefined(container.querySelector("input"));
  input.focus();
  input.setSelectionRange(2, 5);
  const times = container.querySelectorAll("time");
  const first = expectDefined(times[0]);
  const second = expectDefined(times[1]);
  expect(first.textContent).toBe("just now");
  vi.advanceTimersByTime(40_000);
  expect(first.textContent).toBe("just now");
  expect(second.textContent).toBe("1m ago");
  vi.advanceTimersByTime(10_000);
  expect(first.textContent).toBe("1m ago");
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(2);
  expect(input.selectionEnd).toBe(5);
  part.setConnected(false);
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(60_000);
  expect(first.textContent).toBe("1m ago");
  part.setConnected(true);
  expect(first.textContent).toBe("2m ago");
  render(nothing, container);
  expect(vi.getTimerCount()).toBe(0);
});

it("pauses hidden-page clocks and catches up when the page becomes visible", () => {
  render(html`<time>${cardRelativeTime(now, now)}</time>`, container);
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(120_000);
  expect(container.querySelector("time")?.textContent).toBe("just now");
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(container.querySelector("time")?.textContent).toBe("2m ago");
  expect(vi.getTimerCount()).toBe(1);
});
