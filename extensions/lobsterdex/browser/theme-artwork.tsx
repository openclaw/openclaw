/** @jsxImportSource @solidjs/web */
import { createMemo, Loading, Show, useContext } from "solid-js";
import { LobsterHost } from "./host-context.js";

export function PluginThemeArtwork(props: { url: string; class?: string }) {
  const host = useContext(LobsterHost);
  const source = createMemo(() => host.presentation.loadThemeArtwork(props.url).catch(() => null));
  return (
    <Loading on={props.url}>
      <Show when={source()}>{(src) => <img class={props.class} alt="" src={src()} />}</Show>
    </Loading>
  );
}
