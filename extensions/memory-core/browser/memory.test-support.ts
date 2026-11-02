import type {
  ControlUiSettingsContext,
  ControlUiSettingsSnapshot,
  ControlUiSettingsView,
} from "openclaw/plugin-sdk/control-ui";
import { flush } from "solid-js";
import { expect, vi } from "vitest";

export function expectText(node: Node, included: string[], excluded: string[] = []) {
  for (const text of included) {
    expect(node.textContent).toContain(text);
  }
  for (const text of excluded) {
    expect(node.textContent).not.toContain(text);
  }
}
export const findButton = (node: HTMLElement, label: RegExp) =>
  [...node.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    label.test(button.textContent?.trim() ?? ""),
  );

export type MutableSnapshot = {
  -readonly [K in keyof ControlUiSettingsSnapshot]: ControlUiSettingsSnapshot[K];
};
export const snapshot = (overrides: Partial<MutableSnapshot> = {}): MutableSnapshot => ({
  agentId: "main",
  agentsLoading: false,
  agentsError: null,
  engine: { kind: "default", id: "memory-core", availability: "enabled" },
  connected: true,
  connectionEpoch: 1,
  routeIntent: "overview",
  locale: "en",
  ...overrides,
});
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function contextForTest(
  props = snapshot(),
  overrides: Partial<ControlUiSettingsContext> = {},
): ControlUiSettingsContext {
  return {
    props,
    signal: new AbortController().signal,
    components: {
      mountSection: vi.fn(),
      mountRow: vi.fn(),
      mountStatus: vi.fn(),
      mountValue: vi.fn(),
      mountNavigation: vi.fn(),
      mountLobster: vi.fn(),
    },
    request: vi.fn(),
    navigate: vi.fn(),
    refreshAgents: vi.fn(),
    formatError: String,
    formatRelativeTimestamp: String,
    ...overrides,
  };
}
export const disposers: (() => void)[] = [];
export function disposeTestViews() {
  for (const dispose of disposers.splice(0).toReversed()) {
    dispose();
  }
}
export const waitForSolid = (assertion: () => void) =>
  vi.waitFor(() => {
    flush();
    assertion();
  });
export function containerForTest() {
  const container = document.createElement("div");
  document.body.append(container);
  disposers.push(() => container.remove());
  return container;
}
export function mountSettingsView(view: ControlUiSettingsView, context: ControlUiSettingsContext) {
  const container = containerForTest();
  const handle = view.mount(container, context);
  disposers.push(() => handle.dispose());
  flush();
  let props = context.props;
  return {
    container,
    update: (patch: Partial<ControlUiSettingsSnapshot>) => {
      props = { ...props, ...patch };
      handle.update(props);
      flush();
    },
  };
}
