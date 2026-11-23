/** @jsxImportSource @solidjs/web */
import { Portal, render } from "@solidjs/web";
import type {
  ControlUiComposerDecorationProps,
  ControlUiView,
  ControlUiHost,
} from "openclaw/plugin-sdk/control-ui";
import { onSettled, Show, useContext } from "solid-js";
import { LobsterHost } from "./host-context.js";
import type { LobsterPetProps } from "./lobster-pet-contract.js";
import { LobsterPetOwner } from "./lobster-pet-owner.js";
import { LobsterPetScene } from "./lobster-pet-scene-view.js";
import { observeSource } from "./observe.js";
import { lobsterPetSeed } from "./seed.js";

function DismissMenu(props: { position: { x: number; y: number }; owner: LobsterPetOwner }) {
  const host = useContext(LobsterHost);
  let container!: HTMLDivElement;
  onSettled(() => {
    const label = (key: string, fallback: string) => {
      const value = host.presentation.translate(key);
      return value === key ? fallback : value;
    };
    const menu = host.components.mountContextMenu(container, {
      position: props.position,
      label: label("quickSettings.appearance.lobsterVisits", "Lobster visits"),
      items: [
        { id: "dismiss", label: label("common.dismiss", "Dismiss") },
        {
          id: "dismiss-permanently",
          label: label("common.dismissAndDontShowAgain", "Dismiss and don’t show again"),
        },
      ],
      onSelect: (id) => props.owner.dismiss(id === "dismiss-permanently"),
      onClose: () => props.owner.closeMenu(),
    });
    return menu.dispose;
  });
  // The pointer coordinates are relative to the viewport, not the contained
  // composer scroll pane. Keep the anchor and its popup together in that space.
  return (
    <Portal>
      <div class="lobster-pet-dismiss-menu" ref={(element) => (container = element)} />
    </Portal>
  );
}

/** The native view owns the complete visitor lifetime, including timers, audio, and observers. */
export const mountLobsterPet: ControlUiView<ControlUiComposerDecorationProps> = (
  container,
  initial,
) => {
  let current = initial;
  const element = document.createElement("openclaw-lobster-pet");
  const inputs = (): LobsterPetProps => {
    const props = current.props;
    const branding = current.host.presentation.branding;
    return {
      ...props,
      seed: lobsterPetSeed(props.identity),
      residentEnabled: branding.mascot !== "none",
      critters: branding.critters,
      critterArtwork: branding.artwork?.critters,
    };
  };
  const owner = new LobsterPetOwner(element, inputs());
  container.append(element);
  owner.connect();
  owner.update(inputs());
  const disposeView = render(() => <LobsterPetView owner={owner} host={initial.host} />, element);
  const stop = initial.host.subscribe(() => owner.update(inputs()));
  return {
    update(next) {
      current = next;
      owner.update(inputs());
    },
    dispose() {
      stop();
      owner.dispose();
      disposeView();
      element.remove();
    },
  };
};

export function LobsterPetView(props: { owner: LobsterPetOwner; host: ControlUiHost }) {
  const state = observeSource(
    () => props.owner.snapshot(),
    (notify) => props.owner.subscribe(notify),
  );
  return (
    <LobsterHost value={props.host}>
      <LobsterPetScene scene={state().scene} />
      <Show when={state().menuPosition} keyed>
        {(position) => <DismissMenu position={position} owner={props.owner} />}
      </Show>
    </LobsterHost>
  );
}

export default mountLobsterPet;
