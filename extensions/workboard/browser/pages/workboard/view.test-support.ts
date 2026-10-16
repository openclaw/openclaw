import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { createComponent, render } from "@solidjs/web";
import type {
  ControlUiAgentPickerProps,
  ControlUiComponents,
} from "openclaw/plugin-sdk/control-ui";
import { createSignal, flush } from "solid-js";
import { afterEach, vi } from "vitest";
import { getWorkboardState } from "../../lib/workboard/index.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { waitForFast } from "../../test/wait-for.ts";
import { WorkboardView } from "./view.tsx";

const renderedViews = new Set<() => void>();
afterEach(() => {
  renderedViews.forEach((dispose) => dispose());
  renderedViews.clear();
});
export type SelectPicker = HTMLElement & Parameters<ControlUiComponents["mountSelectPicker"]>[1];
export type AgentPicker = HTMLElement & ControlUiAgentPickerProps;

type ViewProps = Parameters<typeof WorkboardView>[0];
export function query<T extends Element = HTMLElement>(root: ParentNode | null, css: string): T {
  return expectDefined(root?.querySelector<T>(css), css);
}
export function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
}
export function submitForm(form: HTMLFormElement) {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}
export function queries(container: HTMLElement) {
  return {
    get: <T extends Element = HTMLElement>(selector: string) => query<T>(container, selector),
    find: container.querySelector.bind(container),
    all: container.querySelectorAll.bind(container),
  };
}
export function createWorkboardView(
  overrides: Partial<ViewProps> = {},
  host: ViewProps["host"] = {},
  initialState: Partial<ReturnType<typeof getWorkboardState>> = {},
) {
  const state = Object.assign(getWorkboardState(host), { loaded: true }, initialState);
  const container = document.createElement("div");
  const props: ViewProps = {
    host,
    client: null,
    connected: true,
    agentsList: null,
    sessions: [],
    onOpenSession: () => undefined,
    onRefresh: () => undefined,
    ...overrides,
  };
  let update: ((next: ViewProps) => void) | undefined;
  const renderView = (next: Partial<ViewProps> = {}) => {
    const renderedProps = { ...props, ...next };
    workboardTestHost().connection.connected = renderedProps.connected;
    if (!container.isConnected) {
      document.body.append(container);
    }
    if (update) {
      update(renderedProps);
    } else {
      const [current, setCurrent] = createSignal(renderedProps);
      const [revision, setRevision] = createSignal(0);
      const invalidate = () => setRevision((value) => value + 1);
      const requestUpdate = () => {
        current().onRequestUpdate?.();
        invalidate();
      };
      const reactiveProps = new Proxy(renderedProps, {
        get: (_target, key) =>
          key === "revision"
            ? revision()
            : key === "onRequestUpdate"
              ? requestUpdate
              : Reflect.get(current(), key),
        ownKeys: () => [...new Set([...Reflect.ownKeys(current()), "revision", "onRequestUpdate"])],
        getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }),
      });
      update = (value) => {
        setCurrent(value);
        invalidate();
      };
      renderedViews.add(render(() => createComponent(WorkboardView, reactiveProps), container));
    }
    flush();
  };
  return { host, state, container, renderView, ...queries(container) };
}

function findButton(root: Element, matches: (button: HTMLButtonElement) => boolean | undefined) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find(matches) ?? null;
}
export function buttonByLabel(container: Element, label: string): HTMLButtonElement | null {
  return findButton(
    container,
    (button) => button.getAttribute("aria-label") === label || button.textContent?.trim() === label,
  );
}

export function buttonByText(container: Element, text: string): HTMLButtonElement | null {
  return findButton(container, (button) => button.textContent?.includes(text));
}

export function requireButton(root: Element, label: string) {
  return expectDefined(buttonByLabel(root, label), label);
}

export function textButton(root: Element, text: string) {
  return expectDefined(buttonByText(root, text), text);
}

export async function inlineEditor(container: Element, field: "title" | "notes" | "labels") {
  const trigger = await waitForFast(() =>
    query<HTMLButtonElement>(container, `.workboard-detail__text-trigger--${field}`),
  );
  const owner = expectDefined(trigger.closest("workboard-inline-text"), "inline editor");
  const popover = owner.querySelector<HTMLElement>("[popover]");
  if (popover) {
    popover.showPopover = vi.fn();
  }
  return {
    trigger,
    owner,
    popover,
    open: async () => {
      trigger.click();
      return waitForFast(() =>
        query<HTMLInputElement | HTMLTextAreaElement>(owner, "input, textarea"),
      );
    },
  };
}

function selectPicker(container: Element, selector: string, label: string) {
  return expectDefined(
    [...container.querySelectorAll<SelectPicker>(`${selector} [data-test-select-picker]`)].find(
      (picker) => picker.accessibleLabel === label,
    ),
    `${label} picker`,
  );
}

export function sessionPicker(container: Element) {
  return selectPicker(container, ".workboard-draft", "Session");
}

export function filterPicker(container: Element, label: string) {
  return selectPicker(
    container,
    label === "Agent" ? ".workboard-agent-filter" : ".workboard-filter-popover",
    label,
  );
}

export function statusButton(container: Element, label: string) {
  return requireButton(
    query<HTMLElement>(container, '.workboard-status-tabs[role="group"][aria-label="Status"]'),
    label,
  );
}

export function toast(container: Element) {
  return query<HTMLElement>(container, "openclaw-workboard-toast:not([hidden])");
}
