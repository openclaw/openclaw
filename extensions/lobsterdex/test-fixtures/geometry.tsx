/** @jsxImportSource @solidjs/web */
// Test-only native entry: deterministic species and timing, real host composer geometry.
import "../browser/styles/lobster-pet.css";
import { render } from "@solidjs/web";
import {
  defineControlUiPlugin,
  type ControlUiView,
  type ControlUiComposerDecorationProps,
} from "openclaw/plugin-sdk/control-ui";
import type { LobsterPetProps } from "../browser/lobster-pet-contract.js";
import { LobsterPetOwner } from "../browser/lobster-pet-owner.js";
import { LobsterPetView } from "../browser/native-pet.js";

type Fixture = Pick<LobsterPetProps, "seed" | "mode" | "runOutcome">;
const mount: ControlUiView<ControlUiComposerDecorationProps> = (container, initial) => {
  let current = initial;
  let fixture: Fixture = { seed: 0, mode: "offline", runOutcome: "ok" };
  const element = document.createElement("openclaw-lobster-pet");
  const inputs = (): LobsterPetProps => ({
    ...current.props,
    ...fixture,
    visitsEnabled: true,
    residentEnabled: true,
    critters: undefined,
    critterArtwork: undefined,
  });
  const owner = new LobsterPetOwner(element, inputs());
  const configure = (event: Event) => {
    // SAFETY: only this test entry installs the fixture event and the browser test supplies this shape.
    fixture = (event as CustomEvent<Fixture>).detail;
    owner.update(inputs());
  };
  element.addEventListener("lobster-fixture-config", configure);
  container.append(element);
  owner.connect();
  owner.update(inputs());
  const dispose = render(() => <LobsterPetView owner={owner} host={initial.host} />, element);
  return {
    update(next) {
      current = next;
      owner.update(inputs());
    },
    dispose() {
      element.removeEventListener("lobster-fixture-config", configure);
      owner.dispose();
      dispose();
      element.remove();
    },
  };
};
export default defineControlUiPlugin({
  id: "lobsterdex",
  activate(host) {
    return host.ui.registerAccessory({ id: "geometry", placement: "composer-decoration", mount });
  },
});
