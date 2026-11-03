/** @jsxImportSource @solidjs/web */

import type { JSX } from "@solidjs/web";
import type {
  ControlUiIconProps,
  ControlUiPresentationHost,
  ControlUiToggleProps,
} from "openclaw/plugin-sdk/control-ui";
import { createEffect, createMemo, getOwner, onCleanup, untrack, useContext } from "solid-js";
import { content, hostControl } from "./host-control.tsx";
import { PresentationContext } from "./presentation-context.ts";

type HostMenuProps = Parameters<ControlUiPresentationHost["mountMenu"]>[1];
type HostMenuEntry = HostMenuProps["items"][number];
export type MenuControls = NonNullable<HostMenuProps["controls"]>;
export type MenuHandle = Parameters<NonNullable<HostMenuProps["ref"]>>[0];
export type MenuEntry =
  | { kind: "content"; id: string; content: JSX.Element }
  | { kind: "group"; id: string; class?: string; items: readonly MenuEntry[] }
  | {
      kind?: "item";
      id: string;
      label: string;
      class?: string;
      type?: "radio" | "checkbox";
      checked?: boolean;
      disabled?: boolean;
      icon?: JSX.Element;
      content?: JSX.Element;
      details?: JSX.Element;
      href?: string;
      attributes?: {
        target?: string;
        rel?: string;
        [name: `data-${string}`]: string | number | boolean | undefined;
      };
      closeOnSelect?: boolean;
      variant?: "danger";
      render?: (attributes: object) => JSX.Element;
    };

export function createMenuControls(): MenuControls {
  const elements = new Set<HTMLElement>();
  return {
    elements,
    ref() {
      let current: HTMLElement | undefined;
      onCleanup(() => {
        if (current) {
          elements.delete(current);
        }
      });
      return (element) => {
        if (current) {
          elements.delete(current);
        }
        elements.add((current = element));
      };
    },
  };
}

export function Icon(props: ControlUiIconProps & { class?: string }) {
  const host = useContext(PresentationContext);
  const element = hostControl(() => ({ name: props.name, className: props.class }), host.mountIcon);
  element.className = "repository-icon";
  return element;
}
export function SettingsToggle(props: ControlUiToggleProps) {
  const host = useContext(PresentationContext);
  return hostControl(() => ({ ...props }), host.mountToggle);
}
export function Tooltip(props: { content: string; disabled?: boolean; children?: JSX.Element }) {
  const host = useContext(PresentationContext);
  const child = content(() => props.children);
  return hostControl(
    () => ({ content: props.content, child, disabled: props.disabled }),
    host.mountTooltip,
  );
}
export function HoverMarquee(props: {
  content: JSX.Element;
  class: string;
  options: Parameters<ControlUiPresentationHost["mountMarquee"]>[1]["options"];
}) {
  const host = useContext(PresentationContext);
  const child = content(() => props.content);
  return hostControl(
    () => ({ content: child, className: props.class, options: props.options }),
    host.mountMarquee,
  );
}
export function createTextOverflow(read: () => unknown) {
  const host = useContext(PresentationContext);
  const value = createMemo(() => ({ content: read() }));
  let handle: ReturnType<ControlUiPresentationHost["mountTextOverflow"]> | undefined;
  createEffect(value, (next) => handle?.update(next));
  onCleanup(() => handle?.dispose());
  return (element: HTMLElement) => {
    handle = host.mountTextOverflow(element, untrack(value));
  };
}
export function Menu(props: {
  id: string;
  class?: string;
  panelClass?: string;
  placement?: "top-end" | "bottom-end";
  label: string;
  disabled?: boolean;
  triggerClass?: string;
  trigger: JSX.Element;
  triggerAttributes?: HostMenuProps["triggerAttributes"];
  items: readonly MenuEntry[];
  presented?: boolean;
  open?: boolean;
  controls?: MenuControls;
  ref?: (handle: MenuHandle) => void;
  onBeforeShow?: (event: Event) => void;
  onOpenChange?: (open: boolean) => void;
  onEscape?: () => boolean;
  children?: JSX.Element;
  onSelect?: (item: { id: string }) => void;
}) {
  const host = useContext(PresentationContext);
  // Native menus invoke custom renderers under their host root; retain this plugin context.
  const owner = getOwner();
  const trigger = content(() => props.trigger);
  const children = content(() => props.children);
  const entry = (item: MenuEntry): HostMenuEntry => {
    if (item.kind === "group") {
      return { ...item, className: item.class, items: item.items.map(entry) };
    }
    if (item.kind === "content") {
      return {
        ...item,
        content: item.content instanceof HTMLElement ? item.content : content(() => item.content),
      };
    }
    return {
      ...item,
      className: item.class,
      icon: item.icon === undefined ? undefined : content(() => item.icon),
      content: item.content === undefined ? undefined : content(() => item.content),
      details: item.details === undefined ? undefined : content(() => item.details),
      render: item.render
        ? (attributes) => content(() => item.render?.(attributes), owner)
        : undefined,
    };
  };
  const items = createMemo(() => props.items.map(entry));
  return hostControl(
    () => ({
      id: props.id,
      className: props.class,
      panelClass: props.panelClass,
      placement: props.placement,
      label: props.label,
      disabled: props.disabled,
      triggerClass: props.triggerClass,
      triggerAttributes: props.triggerAttributes,
      trigger,
      content: children,
      items: items(),
      presented: props.presented !== false && props.open !== false,
      controls: props.controls,
      ref: props.ref,
      onBeforeShow: props.onBeforeShow,
      onOpenChange: props.onOpenChange,
      onEscape: props.onEscape,
      onSelect: (id: string) => props.onSelect?.({ id }),
    }),
    host.mountMenu,
  );
}
