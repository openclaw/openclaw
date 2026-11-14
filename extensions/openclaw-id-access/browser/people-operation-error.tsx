/** @jsxImportSource @solidjs/web */
import { Show } from "solid-js";
import type { PeopleError } from "./people-error.js";

/** A single sanitized diagnostic disclosure, placed at the failed operation. */
export function OperationError(props: { error?: PeopleError | null; page?: boolean }) {
  return (
    <Show when={props.error} keyed>
      {(failure) => (
        <div class={["ocid-access__error", { "callout danger": props.page }]} role="alert">
          <p>{failure.message}</p>
          <Show when={failure.diagnostic}>
            {(diagnostic) => (
              <details class="ocid-access__details">
                <summary>Technical details</summary>
                <code>{diagnostic()}</code>
              </details>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
