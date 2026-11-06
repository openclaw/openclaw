/** @jsxImportSource @solidjs/web */
import { Show } from "solid-js";
import { brandLogoDark, brandLogoLight } from "./brand-mark.js";

export type GlyphKind =
  | "globe"
  | "check"
  | "clock"
  | "denied"
  | "warning"
  | "refresh"
  | "arrow"
  | "shield";

/** A quiet, theme-native glyph; the 1Password mark itself is never altered. */
export function Glyph(props: { kind: GlyphKind }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <Show when={props.kind === "globe"}>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" />
      </Show>
      <Show when={props.kind === "check"}>
        <path d="m6 12 4 4 8-8" />
      </Show>
      <Show when={props.kind === "clock"}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </Show>
      <Show when={props.kind === "denied"}>
        <circle cx="12" cy="12" r="10" />
        <path d="m15 9-6 6m0-6 6 6" />
      </Show>
      <Show when={props.kind === "warning"}>
        <path d="m10.3 3.9-8.1 14a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3l-8.1-14a2 2 0 0 0-3.4 0ZM12 9v4m0 4h.01" />
      </Show>
      <Show when={props.kind === "refresh"}>
        <path d="M3 11a9 9 0 0 1 15.4-6.4L21 7m0-5v5h-5M21 13a9 9 0 0 1-15.4 6.4L3 17m5 0H3v5" />
      </Show>
      <Show when={props.kind === "shield"}>
        <path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6Z" />
      </Show>
      <Show when={props.kind === "arrow"}>
        <path d="M5 12h14m-5-5 5 5-5 5" />
      </Show>
    </svg>
  );
}

/** Use the supplied light/dark primary logos, not a recolored or reconstructed wordmark. */
export function BrandLogo() {
  return (
    <span class="onepassword-approval__logo" role="img" aria-label="1Password">
      <img class="onepassword-approval__logo-light" src={brandLogoLight} alt="" />
      <img class="onepassword-approval__logo-dark" src={brandLogoDark} alt="" />
    </span>
  );
}
