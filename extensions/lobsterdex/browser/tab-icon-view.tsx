/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type { ControlUiView, ControlUiAccessoryProps } from "openclaw/plugin-sdk/control-ui";
import { createSignal, For } from "solid-js";
import { subscribeLobsterdex } from "./lobster-dex.js";
import { LobsterSvg } from "./lobster-pet-artwork.js";
import { canonicalLobsterLook, lobsterLookStyle } from "./lobster-pet-identity.js";
import { lobsterPaletteName } from "./lobster-pet-lore.js";
import { observeSource } from "./observe.js";
import { tabIconPalettes } from "./tab-icons.js";
export const mountTabIcons: ControlUiView<ControlUiAccessoryProps["tab-icon"]> = (
  container,
  initial,
) => {
  const host = initial.host;
  const choices = () => tabIconPalettes(host);

  const [props, setProps] = createSignal(initial.props);
  const dispose = render(() => {
    const read = observeSource(choices, (notify) => {
      const local = subscribeLobsterdex(notify);
      const theme = host.subscribe(notify);
      return () => {
        local();
        theme();
      };
    });
    return (
      <For each={read()}>
        {(palette) => {
          const look = canonicalLobsterLook(palette);
          return (
            <button
              type="button"
              class="settings-tab-icon__pick"
              aria-pressed={props().value === "lobster:" + palette.id ? "true" : "false"}
              aria-label={lobsterPaletteName(palette.id)}
              title={lobsterPaletteName(palette.id)}
              onClick={() => props().onChange("lobster:" + palette.id)}
            >
              <span
                class={[
                  "lobster-pet settings-tab-icon__lobster",
                  "lobster-pet--palette-" + palette.id,
                ]}
                style={lobsterLookStyle(look)}
                aria-hidden="true"
              >
                <LobsterSvg look={look} standalone />
              </span>
            </button>
          );
        }}
      </For>
    );
  }, container);
  return {
    update(next) {
      setProps(next.props);
    },
    dispose,
  };
};

export default mountTabIcons;
