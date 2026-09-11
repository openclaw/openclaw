import { html } from "lit";
import { live } from "lit/directives/live.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { renderAppearancePicker, renderDialog } from "../../components/host-components.ts";
import { icons } from "../../components/icons.ts";
import { renderWorkboardToast, updateWorkboardToastOutcome } from "../../components/toast.ts";
import { renderWorkboardBoardGlyph } from "../../components/workboard-board-glyph.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { WorkboardBoardSummary } from "../../lib/workboard/types.ts";

export type BoardDraft = {
  id: string;
  name: string;
  icon: string;
  color: string;
  saving: boolean;
  error: string | null;
};
const originals = new WeakMap<BoardDraft, Pick<BoardDraft, "name" | "icon" | "color">>();

export function createBoardDraft(board: WorkboardBoardSummary): BoardDraft {
  const fields = { name: board.name ?? board.id, icon: board.icon ?? "", color: board.color ?? "" };
  const draft: BoardDraft = {
    id: board.id,
    ...fields,
    saving: false,
    error: null,
  };
  originals.set(draft, fields);
  return draft;
}

export function renderBoardModal(props: {
  draft: BoardDraft;
  pageError?: string | null;
  toastOwner: object;
  client: GatewayBrowserClient | null;
  readonly canWrite: boolean;
  onSaved: () => void;
  onCancel: () => void;
  requestUpdate: () => void;
}) {
  const { draft } = props;
  const visibleError = draft.error ?? props.pageError;
  updateWorkboardToastOutcome(draft, {
    message: draft.error ?? "",
    key: draft.error,
    tone: "error",
  });
  const save = async () => {
    if (!props.client || !props.canWrite || draft.saving || !draft.name.trim()) {
      return;
    }
    const input: Record<string, string | null> = { id: draft.id };
    const original = originals.get(draft);
    for (const field of ["name", "icon", "color"] as const) {
      const value = draft[field].trim();
      if (value !== original?.[field]) {
        input[field] = value || null;
      }
    }
    draft.saving = true;
    draft.error = null;
    props.requestUpdate();
    try {
      await props.client.request("workboard.boards.upsert", input);
      props.onSaved();
    } catch (error) {
      draft.error = formatUiError(error);
    } finally {
      draft.saving = false;
      props.requestUpdate();
    }
  };
  return renderDialog(
    {
      label: t("workboard.editBoard"),
      style: "--openclaw-modal-width: 420px; --openclaw-modal-backdrop-filter: blur(1px);",
      onCancel: () => {
        if (draft.saving) {
          return false;
        }
        props.onCancel();
        return true;
      },
    },
    html`<form
        class="workboard-draft workboard-board-draft"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          void save();
        }}
      >
        <div class="workboard-modal__header">
          <h2>${t("workboard.editBoard")}</h2>
          <button
            class="btn btn--icon workboard-modal__close"
            type="button"
            aria-label=${t("common.close")}
            ?disabled=${draft.saving}
            @click=${props.onCancel}
          >
            ${icons.x}
          </button>
        </div>
        <div class="workboard-board-draft__identity">
          <div class="workboard-board-draft__preview">${renderWorkboardBoardGlyph(draft)}</div>
          <label class="workboard-board-draft__name">
            <span>${t("workboard.boardName")}</span>
            <input
              class="settings-input"
              autofocus
              required
              maxlength="120"
              .value=${live(draft.name)}
              ?disabled=${draft.saving || !props.canWrite}
              @input=${(event: Event) => {
                if (!(event.currentTarget instanceof HTMLInputElement)) {
                  return;
                }
                draft.name = event.currentTarget.value;
                props.requestUpdate();
              }}
            />
          </label>
        </div>
        <section
          class="workboard-board-draft__appearance"
          aria-label=${t("workboard.boardAppearance")}
        >
          ${renderAppearancePicker({
            icon: draft.icon || null,
            color: draft.color || null,
            disabled: draft.saving || !props.canWrite,
            clearable: true,
            onChange: ({ icon, color }) => {
              draft.icon = icon ?? "";
              draft.color = color ?? "";
              props.requestUpdate();
            },
          })}
        </section>
        <div class="workboard-modal__actions">
          <button class="btn" type="button" ?disabled=${draft.saving} @click=${props.onCancel}>
            ${t("common.cancel")}
          </button>
          <button
            class="btn primary"
            type="submit"
            ?disabled=${draft.saving || !props.client || !props.canWrite || !draft.name.trim()}
          >
            ${t("common.save")}
          </button>
        </div>
      </form>
      ${renderWorkboardToast({
        owner: draft.error ? draft : props.toastOwner,
        message: visibleError ?? "",
        key: visibleError,
        tone: "error",
      })}`,
  );
}
