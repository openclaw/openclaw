/** @jsxImportSource @solidjs/web */
import { Portal, type JSX } from "@solidjs/web";
import type {
  ControlUiComponentHandle,
  ControlUiSettingsComponents,
} from "openclaw/plugin-sdk/control-ui";
import { createEffect, getOwner, onSettled, runWithOwner } from "solid-js";

type Section = Parameters<ControlUiSettingsComponents["mountSection"]>[1];
type Row = Parameters<ControlUiSettingsComponents["mountRow"]>[1];

export function createSettingsComponents(components: ControlUiSettingsComponents) {
  function bridge<P extends object>(
    read: () => P,
    mount: (container: HTMLElement, props: P) => ControlUiComponentHandle<P>,
  ) {
    const owner = getOwner();
    let container: HTMLElement | undefined;
    let handle: ControlUiComponentHandle<P> | undefined;
    // The host owns this visual island; apply its imperative update contract.
    createEffect(read, (props) => {
      if (!container) {
        return;
      }
      if (handle) {
        handle.update(props);
      } else {
        handle = runWithOwner(owner, () => mount(container!, props));
      }
    });
    onSettled(() => () => handle?.dispose());
    return (node: HTMLElement) => {
      container = node;
    };
  }
  const contentNode = () => {
    const node = document.createElement("span");
    node.style.display = "contents";
    return node;
  };
  function SettingsSection(props: { title: string; children?: JSX.Element }) {
    const content = contentNode();
    const mount = bridge<Section>(() => ({ title: props.title, content }), components.mountSection);
    return (
      <>
        <Portal mount={content}>{props.children}</Portal>
        <span style={{ display: "contents" }} ref={mount} />
      </>
    );
  }
  function SettingsRow(props: { title: string; description?: JSX.Element; control?: JSX.Element }) {
    const description = contentNode();
    const control = contentNode();
    const mount = bridge<Row>(
      () => ({
        title: props.title,
        description: props.description == null ? undefined : description,
        control,
      }),
      components.mountRow,
    );
    return (
      <>
        <Portal mount={description}>{props.description}</Portal>
        <Portal mount={control}>{props.control}</Portal>
        <span style={{ display: "contents" }} ref={mount} />
      </>
    );
  }
  function SettingsStatus(props: Parameters<ControlUiSettingsComponents["mountStatus"]>[1]) {
    return (
      <span
        style={{ display: "contents" }}
        ref={bridge(() => ({ ...props }), components.mountStatus)}
      />
    );
  }
  function SettingsValue(props: Parameters<ControlUiSettingsComponents["mountValue"]>[1]) {
    return (
      <span
        style={{ display: "contents" }}
        ref={bridge(() => ({ ...props }), components.mountValue)}
      />
    );
  }
  function SettingsNavRow(props: Parameters<ControlUiSettingsComponents["mountNavigation"]>[1]) {
    return (
      <span
        style={{ display: "contents" }}
        ref={bridge(() => ({ ...props }), components.mountNavigation)}
      />
    );
  }
  function Lobster(props: Parameters<ControlUiSettingsComponents["mountLobster"]>[1]) {
    return (
      <span
        style={{ display: "contents" }}
        ref={bridge(() => ({ ...props }), components.mountLobster)}
      />
    );
  }
  return { SettingsSection, SettingsRow, SettingsStatus, SettingsValue, SettingsNavRow, Lobster };
}
