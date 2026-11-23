/** @jsxImportSource @solidjs/web */
import { resolveThemeBranding } from "@openclaw/gateway-protocol/theme";
import type { ControlUiAccessoryProps, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { expect, it, vi, onTestFinished } from "vitest";
import type { ApplicationContext } from "../../../ui/src/app/context.ts";
import { t } from "../../../ui/src/i18n/index.ts";
import { registerPreferencesEnglish } from "../../../ui/src/i18n/locales/en-preferences.ts";
import { registerSettingsEnglish } from "../../../ui/src/i18n/locales/en-settings.ts";
import { registerEnglishCatalog } from "../../../ui/src/lib/reactive/i18n.ts";
import { createControlUiComponents } from "../../../ui/src/plugins/control-ui-components.ts";
import { createInertViewHost } from "../../../ui/src/plugins/control-ui-view.test-support.ts";
import { flush, waitForSolid } from "../../../ui/src/test-helpers/solid-settle.ts";
import { mountAppearance } from "./appearance.js";

registerEnglishCatalog(registerPreferencesEnglish);
registerEnglishCatalog(registerSettingsEnglish);
type Props = ControlUiAccessoryProps["ambient-appearance"];
const updates = new WeakMap<HTMLElement, (props: Props) => void>();
function renderAppearance(options: { onOpenLobsterdex?: () => void } = {}) {
  const abort = new AbortController();
  const container = document.createElement("div");
  const host = createInertViewHost(abort.signal);
  Object.assign(host, {
    subscribe: () => () => {},
    presentation: { version: 1, branding: resolveThemeBranding(undefined), translate: t },
    navigation: {
      pageHref: () => "/settings/lobsterdex",
      openPage: options.onOpenLobsterdex ?? vi.fn(),
    },
    components: createControlUiComponents({
      current: () => ({}) as ApplicationContext,
      signal: abort.signal,
      onError: (error) => {
        throw error;
      },
    }),
  });
  const props: Props = {
    visitsEnabled: true,
    soundsEnabled: false,
    themeName: "Claw",
    onChange: vi.fn(),
  };
  const context: ControlUiViewContext<Props> = {
    props,
    host,
    signal: abort.signal,
    presented: true,
    mountDefault: () => () => {},
  };
  const view = mountAppearance(container, context);
  updates.set(container, (next) => view?.update?.({ ...context, props: next }));
  onTestFinished(() => {
    view?.dispose?.();
    abort.abort();
    container.remove();
    vi.unstubAllGlobals();
  });
  flush();
  return { container, props };
}
function renderConfigInto(props: Props, container: HTMLElement) {
  updates.get(container)?.({ ...props });
  flush();
}
function required<T extends Element>(
  container: Element,
  selector: string,
  type: new (...args: never[]) => T,
): T {
  const element = container.querySelector(selector);
  if (!(element instanceof type)) {
    throw new Error("Missing control " + selector);
  }
  return element;
}
function settingsRow(container: HTMLElement, title: string) {
  const row = [...container.querySelectorAll<HTMLElement>(".settings-row")].find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent === title,
  );
  if (!row) {
    throw new Error("Missing row " + title);
  }
  return row;
}
it("previews lobster sounds only when the user enables them", async () => {
  const param = () => ({
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  });
  const audioContextCtor = vi.fn(function MockAudioContext() {
    return {
      state: "running",
      currentTime: 0,
      destination: {},
      resume: vi.fn(),
      close: vi.fn(() => Promise.resolve()),
      createOscillator: vi.fn(() => ({
        type: "sine",
        frequency: param(),
        connect: (node: unknown) => node,
        start: vi.fn(),
        stop: vi.fn(),
      })),
      createGain: vi.fn(() => ({ gain: param(), connect: vi.fn() })),
    };
  });
  vi.stubGlobal("AudioContext", audioContextCtor);

  const soundSwitch = (container: HTMLElement) =>
    required(settingsRow(container, "Lobster sounds"), ".settings-toggle__input", HTMLInputElement);

  const { container, props } = renderAppearance();
  document.body.append(container);
  onTestFinished(() => container.remove());
  await waitForSolid(() => expect(container.querySelectorAll("[role=switch]")).toHaveLength(2));
  const disabledSwitch = soundSwitch(container);

  expect(audioContextCtor).not.toHaveBeenCalled();
  disabledSwitch.click();
  expect(audioContextCtor).toHaveBeenCalledTimes(1);
  expect(props.onChange).toHaveBeenCalledWith({ soundsEnabled: true });

  props.soundsEnabled = true;
  renderConfigInto(props, container);
  const enabledSwitch = soundSwitch(container);

  const noOpKey = new KeyboardEvent("keydown", {
    key: "ArrowRight",
    bubbles: true,
    composed: true,
  });
  enabledSwitch.dispatchEvent(noOpKey);
  expect(audioContextCtor).toHaveBeenCalledTimes(1);

  enabledSwitch.click();
  expect(audioContextCtor).toHaveBeenCalledTimes(1);
  expect(props.onChange).toHaveBeenLastCalledWith({ soundsEnabled: false });
});

it("opens the full Lobsterdex from its own row", async () => {
  const onOpenLobsterdex = vi.fn();
  const { container } = renderAppearance({
    onOpenLobsterdex,
  });
  document.body.append(container);
  onTestFinished(() => container.remove());

  const openLink = required(container, "a.lobsterdex__open", HTMLAnchorElement);
  expect(openLink.getAttribute("href")).toBe("/settings/lobsterdex");
  expect(openLink.textContent).toContain("visited");
  openLink.addEventListener("click", (event) => event.preventDefault(), {
    capture: true,
    once: true,
  });
  openLink.click();
  expect(onOpenLobsterdex).not.toHaveBeenCalled();

  openLink.click();
  expect(onOpenLobsterdex).toHaveBeenCalledOnce();
});
