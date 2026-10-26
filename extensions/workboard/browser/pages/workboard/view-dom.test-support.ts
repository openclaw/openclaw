import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import type { WorkboardCard } from "../../lib/workboard/types.ts";
import { createWorkboardView } from "./view.test-support.ts";

export function element<T extends Element = HTMLElement>(
  root: ParentNode | null | undefined,
  selector: string,
) {
  return expectDefined(root?.querySelector<T>(selector), selector);
}

export function enterText(target: HTMLInputElement | HTMLTextAreaElement, value: string) {
  target.value = value;
  target.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

export function submitForm(target: HTMLFormElement) {
  target.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

export function expectText(root: ParentNode, selector: string, ...values: string[]) {
  for (const value of values) {
    expect(root.querySelector(selector)?.textContent).toContain(value);
  }
}

export function expectAbsent(root: ParentNode, ...selectors: string[]) {
  for (const selector of selectors) {
    expect(root.querySelector(selector)).toBeNull();
  }
}

export function expectValue(root: ParentNode, selector: string, value: string) {
  expect(root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)?.value).toBe(value);
}

export function detailView(
  card: WorkboardCard,
  props: Parameters<typeof createWorkboardView>[0] = {},
) {
  const view = createWorkboardView(props);
  view.state.cards = [card];
  view.state.detailCardId = card.id;
  return view;
}

export function selectedView(
  cards: WorkboardCard[],
  props: Parameters<typeof createWorkboardView>[0] = {},
) {
  const view = createWorkboardView(props);
  view.state.cards = cards;
  view.state.selectedCardIds = new Set(cards.map((card) => card.id));
  return view;
}
