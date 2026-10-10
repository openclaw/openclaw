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
export function createLoadedWorkboardState() {
  const host = {};
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
  const state = getWorkboardState(host);
  state.loaded = true;
  const container = document.createElement("div");
  const props = createWorkboardRenderProps(host, overrides);
  const renderView = (next: Partial<WorkboardRenderProps> = {}) =>
    renderInto(container, { ...props, ...next });
  return { host, state, container, renderView };
}

export function buttonByLabel(container: Element, label: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) =>
        button.getAttribute("aria-label") === label || button.textContent?.trim() === label,
    ) ?? null
  );
}

export function buttonByText(container: Element, text: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes(text),
    ) ?? null
  );
}

export function requireButton(root: Element, label: string) {
  return expectDefined(buttonByLabel(root, label), label);
}

export function textButton(root: Element, text: string) {
  return expectDefined(buttonByText(root, text), text);
}

export async function inlineEditor(container: Element, field: "title" | "notes" | "labels") {
  const trigger = await waitForFast(() =>
    expectDefined(
      container.querySelector<HTMLButtonElement>(`.workboard-detail__text-trigger--${field}`),
      `.workboard-detail__text-trigger--${field}`,
    ),
  );
  const owner = expectDefined(
    trigger.closest<HTMLElement>("workboard-inline-text"),
    "inline editor",
  );
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
        expectDefined(
          owner.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea"),
          "input, textarea",
        ),
      );
    },
  };
}

function draftPicker(container: Element, label: string) {
  return expectDefined(
    [
      ...container.querySelectorAll<SelectPicker>(".workboard-draft [data-test-select-picker]"),
    ].find((picker) => picker.accessibleLabel === label),
    `card ${label} picker`,
  );
}

export function sessionPicker(container: Element) {
  return draftPicker(container, "Session");
}

export function filterPicker(container: Element, label: string) {
  return expectDefined(
    [
      ...container.querySelectorAll<SelectPicker>(
        label === "Agent"
          ? ".workboard-agent-filter [data-test-select-picker]"
          : ".workboard-filter-popover [data-test-select-picker]",
      ),
    ].find((picker) => picker.accessibleLabel === label),
    `filter picker ${label}`,
  );
}

export function statusButton(container: Element, label: string) {
  return requireButton(
    expectDefined(
      container.querySelector<HTMLElement>(
        '.workboard-status-tabs[role="group"][aria-label="Status"]',
      ),
      '.workboard-status-tabs[role="group"][aria-label="Status"]',
    ),
    label,
  );
}

export function toast(container: Element) {
  return expectDefined(
    container.querySelector<HTMLElement>("openclaw-workboard-toast:not([hidden])"),
    "openclaw-workboard-toast:not([hidden])",
  );
}
