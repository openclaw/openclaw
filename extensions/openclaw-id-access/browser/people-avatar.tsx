/** @jsxImportSource @solidjs/web */
import { Show } from "solid-js";
import { personInitials } from "./people-format.js";

export function Avatar(props: { name?: string }) {
  return (
    <span
      class={["ocid-access__avatar", { "ocid-access__avatar--unknown": !props.name }]}
      aria-hidden="true"
    >
      <Show
        when={props.name}
        fallback={
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <circle cx="12" cy="7" r="4" />
            <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
          </svg>
        }
      >
        {personInitials(props.name ?? "")}
      </Show>
    </span>
  );
}
