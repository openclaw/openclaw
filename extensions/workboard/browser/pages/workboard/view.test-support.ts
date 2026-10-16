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

const renderedViews = new Map<
  HTMLElement,
  { update: (props: WorkboardRenderProps) => void; dispose: () => void }
>();
afterEach(() => {
  for (const view of renderedViews.values()) {
    view.dispose();
  }
  renderedViews.clear();
});
type ControlUiSelectPickerProps = Parameters<ControlUiComponents["mountSelectPicker"]>[1];
export type SelectPicker = HTMLElement & ControlUiSelectPickerProps;
export type AgentPicker = HTMLElement & ControlUiAgentPickerProps;

type WorkboardRenderProps = Parameters<typeof WorkboardView>[0];
export function query<T extends Element = HTMLElement>(
  root: ParentNode | null | undefined,
  selector: string,
): T {
  return expectDefined(root?.querySelector<T>(selector), selector);
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
export function createLoadedWorkboardState(host: WorkboardRenderProps["host"] = {}) {
  const state = getWorkboardState(host);
  state.loaded = true;
  return { host, state };
}

export function createWorkboardRenderProps(
  host: WorkboardRenderProps["host"],
  overrides: Partial<WorkboardRenderProps> = {},
): WorkboardRenderProps {
  return {
    host,
    client: null,
    connected: true,
    agentsList: null,
    sessions: [],
    onOpenSession: () => undefined,
    onRefresh: () => undefined,
    ...overrides,
  };
}

export function renderInto(container: HTMLElement, props: WorkboardRenderProps) {
  workboardTestHost().connection.connected = props.connected;
  if (!container.isConnected) {
    document.body.append(container);
  }
  const mounted = renderedViews.get(container);
  if (mounted) {
    mounted.update(props);
  } else {
    const [current, setCurrent] = createSignal(props);
    const [revision, setRevision] = createSignal(0);
    const requestUpdate = () => {
      current().onRequestUpdate?.();
      setRevision((value) => value + 1);
    };
    const reactiveProps = new Proxy(props, {
      get(_target, key) {
        if (key === "revision") {
          return revision();
        }
        if (key === "onRequestUpdate") {
          return requestUpdate;
        }
        return Reflect.get(current(), key);
      },
      ownKeys() {
        return [...new Set([...Reflect.ownKeys(current()), "revision", "onRequestUpdate"])];
      },
      getOwnPropertyDescriptor() {
        return { configurable: true, enumerable: true };
      },
    });
    const dispose = render(() => createComponent(WorkboardView, reactiveProps), container);
    renderedViews.set(container, {
      update(next) {
        setCurrent(next);
        setRevision((value) => value + 1);
      },
      dispose,
    });
  }
  flush();
}

export function createWorkboardView(
  overrides: Partial<WorkboardRenderProps> = {},
  host: WorkboardRenderProps["host"] = {},
) {
  const { state } = createLoadedWorkboardState(host);
  const container = document.createElement("div");
  const props = createWorkboardRenderProps(host, overrides);
  const renderView = (next: Partial<WorkboardRenderProps> = {}) =>
    renderInto(container, { ...props, ...next });
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
