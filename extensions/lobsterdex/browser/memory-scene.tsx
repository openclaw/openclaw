/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type { ControlUiAccessoryProps, ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { createMemo, createSignal } from "solid-js";
import { LobsterSvg } from "./lobster-pet-artwork.js";
import { createLobsterPetLook, lobsterLookStyle } from "./lobster-pet-identity.js";
import { lobsterPetSeed } from "./seed.js";

export const mountMemoryScene: ControlUiView<ControlUiAccessoryProps["memory-scene"]> = (
  container,
  initial,
) => {
  const [props, setProps] = createSignal(initial.props);
  const dispose = render(() => {
    const look = createMemo(() => createLobsterPetLook(lobsterPetSeed(props().identity)));
    return (
      <div style={lobsterLookStyle(look()) + ";display:contents"}>
        <LobsterSvg
          look={look()}
          sleeping={props().sleeping}
          reading={props().reading}
          grumpy={props().grumpy}
          standalone={props().standalone}
        />
      </div>
    );
  }, container);
  return {
    update(next) {
      setProps(next.props);
    },
    dispose,
  };
};

export default mountMemoryScene;
