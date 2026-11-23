/** @jsxImportSource @solidjs/web */
import { insert } from "@solidjs/web";
import { createRoot } from "solid-js";
import type { LobsterPetLook } from "./api.ts";
import { LobsterSvg, type LobsterSvgProps } from "./lobster-pet-artwork.tsx";

export function renderLobsterSvg(
  look: LobsterPetLook,
  options: Omit<LobsterSvgProps, "look"> = {},
) {
  // Imperative image consumers need inert artwork, not a live renderer root.
  return createRoot((dispose) => {
    const host = document.createElement("div");
    try {
      insert(host, <LobsterSvg look={look} {...options} />);
      const snapshot = document.createDocumentFragment();
      for (const child of host.childNodes) {
        snapshot.append(child.cloneNode(true));
      }
      return snapshot;
    } finally {
      dispose();
    }
  });
}
