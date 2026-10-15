/** @jsxImportSource @solidjs/web */
import { Portal, type JSX } from "@solidjs/web";
import type { ControlUiComponentHandle, ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createEffect, onCleanup } from "solid-js";
import { workboardHost } from "../host.ts";

type Components = ControlUiHost["components"];
type DialogProps = Parameters<Components["mountDialog"]>[1];
type PickerProps = Parameters<Components["mountAgentPicker"]>[1];
type AvatarProps = Parameters<Components["mountAgentAvatar"]>[1];
type SelectPickerProps = Parameters<Components["mountSelectPicker"]>[1];
type AppearancePickerProps = Parameters<Components["mountAppearancePicker"]>[1];
type AppearanceGlyphProps = Parameters<Components["mountAppearanceGlyph"]>[1];
type SessionSummaryProps = Parameters<Components["mountSessionSummary"]>[1];
type Styled = { class?: string; className?: string };

function hostMount<Props extends object>(
  read: () => Props,
  mount: (container: HTMLElement, props: Props) => ControlUiComponentHandle<Props>,
) {
  let container: HTMLElement | undefined;
  let handle: ControlUiComponentHandle<Props> | undefined;
  createEffect(read, (props) => {
    if (!container) {
      return;
    }
    if (handle) {
      handle.update(props);
    } else {
      handle = mount(container, props);
    }
  });
  onCleanup(() => handle?.dispose());
  return (node: HTMLElement) => {
    container = node;
  };
}

export function Dialog(
  props: Omit<DialogProps, "content"> & { children?: JSX.Element; content?: JSX.Element },
) {
  const content = document.createElement("div");
  content.style.display = "contents";
  // Plugin rendering owns the content; the SDK owns the containing dialog and focus policy.
  const mount = hostMount(
    () => ({
      label: props.label,
      description: props.description,
      className: props.className,
      style: props.style,
      returnFocusTarget: props.returnFocusTarget,
      onCancel: props.onCancel,
      content,
    }),
    (container, value) => workboardHost().components.mountDialog(container, value),
  );
  return (
    <>
      <Portal mount={content}>{props.children ?? props.content}</Portal>
      <div style={{ display: "contents" }} ref={mount} />
    </>
  );
}

export function AgentPicker(props: PickerProps & Styled) {
  const mount = hostMount(
    () => ({ ...props }),
    (container, value) => workboardHost().components.mountAgentPicker(container, value),
  );
  return <div class={props.class ?? props.className ?? ""} ref={mount} />;
}

export function AgentAvatar(props: AvatarProps) {
  const mount = hostMount(
    () => ({ ...props }),
    (container, value) => workboardHost().components.mountAgentAvatar(container, value),
  );
  return <span aria-hidden="true" ref={mount} />;
}

export function SelectPicker(props: SelectPickerProps & Styled) {
  const mount = hostMount(
    () => ({ ...props }),
    (container, value) => workboardHost().components.mountSelectPicker(container, value),
  );
  return <div class={props.class ?? props.className ?? ""} ref={mount} />;
}

export function AppearancePicker(props: AppearancePickerProps & Styled) {
  const mount = hostMount(
    () => ({ ...props }),
    (container, value) => workboardHost().components.mountAppearancePicker(container, value),
  );
  return <div class={props.class ?? props.className ?? ""} ref={mount} />;
}

export function AppearanceGlyph(props: AppearanceGlyphProps & Styled) {
  const mount = hostMount(
    () => ({ ...props }),
    (container, value) => workboardHost().components.mountAppearanceGlyph(container, value),
  );
  return (
    <span
      class={props.class ?? props.className ?? ""}
      style={{
        "--workboard-board-color":
          workboardHost().components.resolveAppearanceColor(props.color) || "var(--muted)",
      }}
      aria-hidden="true"
      ref={mount}
    />
  );
}

export function SessionSummary(props: SessionSummaryProps) {
  const mount = hostMount(
    () => ({ ...props }),
    (container, value) => workboardHost().components.mountSessionSummary(container, value),
  );
  return <div class="workboard-session-summary" ref={mount} />;
}
