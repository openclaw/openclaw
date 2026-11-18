/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import { children, Show } from "solid-js";

// Plugin-owned native markup consumes the host's existing Settings stylesheet.
export function SettingsRow(props: {
  title: JSX.Element;
  description?: JSX.Element;
  control?: JSX.Element;
  role?: "alert" | "status";
}) {
  const control = children(() => props.control);
  return (
    <div class="settings-row" role={props.role}>
      <div class="settings-row__text">
        <span class="settings-row__title">{props.title}</span>
        <Show when={props.description}>
          <span class="settings-row__desc">{props.description}</span>
        </Show>
      </div>
      <Show when={control() !== undefined && control() !== null && control() !== false}>
        <div class="settings-row__control">{control()}</div>
      </Show>
    </div>
  );
}

export function SettingsStatus(props: { kind: "ok" | "muted" | "danger"; label: JSX.Element }) {
  return (
    <span
      class={[
        "settings-status",
        {
          "settings-status--ok": props.kind === "ok",
          "settings-status--danger": props.kind === "danger",
        },
      ]}
    >
      <span class="settings-status__dot" />
      <span>{props.label}</span>
    </span>
  );
}
