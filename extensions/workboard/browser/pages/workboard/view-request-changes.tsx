/** @jsxImportSource @solidjs/web */
import { WORKBOARD_REWORK_INSTRUCTIONS_MAX_LENGTH } from "@openclaw/workboard-contract";
import { createSignal, createUniqueId } from "solid-js";
import { icons } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import { requestWorkboardChanges } from "../../lib/workboard/execution.ts";
import type { WorkboardCard } from "../../lib/workboard/types.ts";
import { workboardMutationContext, type WorkboardProps } from "./view-helpers.tsx";

export function RequestChangesForm(props: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  busy: boolean;
}) {
  const [instructions, setInstructions] = createSignal("");
  const instructionsId = createUniqueId();
  const unavailable = () => !props.workboard.connected || !props.workboard.client || props.busy;
  return (
    <details class="workboard-detail__disclosure">
      <summary>
        <span class="workboard-detail__disclosure-chevron" aria-hidden="true">
          {icons.chevronDown}
        </span>
        {t("workboard.requestChanges")}
      </summary>
      <form
        class="workboard-detail__comment-compose"
        onSubmit={(event) => {
          event.preventDefault();
          const text = instructions().trim();
          if (!text || unavailable()) {
            return;
          }
          void requestWorkboardChanges({
            ...workboardMutationContext(props.workboard),
            card: props.card,
            instructions: text,
          });
        }}
      >
        <label for={instructionsId}>{t("workboard.reworkInstructions")}</label>
        <textarea
          id={instructionsId}
          class="settings-input workboard-detail__note"
          required
          rows={3}
          maxlength={WORKBOARD_REWORK_INSTRUCTIONS_MAX_LENGTH}
          value={instructions()}
          onInput={(event) => setInstructions(event.currentTarget.value)}
        />
        <button class="btn" type="submit" disabled={unavailable() || !instructions().trim()}>
          {t("workboard.startRework")}
        </button>
      </form>
    </details>
  );
}
