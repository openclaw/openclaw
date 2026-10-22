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
        props.kind === "muted" ? undefined : `settings-status--${props.kind}`,
      ]}
    >
      <span class="settings-status__dot" />
      <span>{props.label}</span>
    </span>
  );
}

export function SettingsSection(props: {
  title: string;
  description: string;
  count?: number;
  children: JSX.Element;
}) {
  return (
    <section class="settings-section">
      <div class="settings-section__header">
        <div class="settings-section__copy">
          <h2 class="settings-section__heading">
            {props.title}
            <Show when={props.count !== undefined}>
              {" "}
              <span class="settings-count">{props.count}</span>
            </Show>
          </h2>
          <p class="settings-section__desc">{props.description}</p>
        </div>
      </div>
      <div class="settings-group">{props.children}</div>
    </section>
  );
}
