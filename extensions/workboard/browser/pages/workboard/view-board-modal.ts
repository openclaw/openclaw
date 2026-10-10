import {
  normalizeWorkboardSessionsBoardSpec,
  type WorkboardSessionsBoardSpec,
} from "@openclaw/workboard-contract";
import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { renderAppearancePicker, renderDialog } from "../../components/host-components.ts";
import { icons } from "../../components/icons.ts";
import { renderWorkboardErrorToast, updateWorkboardToastOutcome } from "../../components/toast.ts";
import { renderWorkboardBoardGlyph } from "../../components/workboard-board-glyph.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { WorkboardBoardMetadata, WorkboardBoardSummary } from "../../lib/workboard/types.ts";

export type BoardDraft = {
  id: string;
  name: string;
  icon: string;
  color: string;
  kind: "cards" | "sessions";
  create?: boolean;
  sessions?: WorkboardSessionsBoardSpec;
  saving: boolean;
  error: string | null;
};
const originals = new WeakMap<
  BoardDraft,
  Pick<BoardDraft, "name" | "icon" | "color" | "sessions">
>();

export function createBoardDraft(board: WorkboardBoardSummary): BoardDraft {
  const fields = { name: board.name ?? board.id, icon: board.icon ?? "", color: board.color ?? "" };
  const draft: BoardDraft = {
    id: board.id,
    ...fields,
    kind: board.kind ?? "cards",
    ...(board.sessions ? { sessions: structuredClone(board.sessions) } : {}),
    saving: false,
    error: null,
  };
  originals.set(draft, { ...fields, sessions: structuredClone(draft.sessions) });
  return draft;
}

export function createNewBoardDraft(): BoardDraft {
  const draft: BoardDraft = {
    id: `board-${crypto.randomUUID()}`,
    name: "",
    icon: "",
    color: "",
    kind: "cards",
    create: true,
    saving: false,
    error: null,
  };
  originals.set(draft, { name: "", icon: "", color: "" });
  return draft;
}

export function renderBoardModal(props: {
  draft: BoardDraft;
  pageError?: string | null;
  toastOwner: object;
  client: GatewayBrowserClient | null;
  readonly canWrite: boolean;
  onSaved: (board: WorkboardBoardMetadata) => void;
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
    let sessions: WorkboardSessionsBoardSpec | undefined;
    try {
      sessions = draft.sessions ? normalizeWorkboardSessionsBoardSpec(draft.sessions) : undefined;
    } catch (error) {
      draft.error = formatUiError(error);
      props.requestUpdate();
      return;
    }
    const input: Record<string, string | string[]> = { id: draft.id };
    if (draft.create && draft.kind === "sessions") {
      input.kind = "sessions";
    }
    const clearAppearance: string[] = [];
    const original = originals.get(draft);
    for (const field of ["name", "icon", "color"] as const) {
      const value = draft[field].trim();
      if (value !== original?.[field]) {
        if (!value && field !== "name") {
          clearAppearance.push(field);
        } else {
          input[field] = value;
        }
      }
    }
    if (clearAppearance.length > 0) {
      input.clearAppearance = clearAppearance;
    }
    draft.saving = true;
    draft.error = null;
    props.requestUpdate();
    try {
      const { board } = await props.client.request<{ board: WorkboardBoardMetadata }>(
        "workboard.boards.upsert",
        input,
      );
      if (
        sessions &&
        JSON.stringify(draft.sessions?.columns) !== JSON.stringify(original?.sessions?.columns)
      ) {
        if (!props.canWrite) {
          throw new Error(t("workboard.sessionsBoard.writeUnavailable"));
        }
        await props.client.request("workboard.sessionsBoard.update", {
          boardId: draft.id,
          patch: { columns: sessions.columns },
        });
      }
      props.onSaved(board);
    } catch (error) {
      draft.error = formatUiError(error);
    } finally {
      draft.saving = false;
      props.requestUpdate();
    }
  };
  return renderDialog(
    {
      label: t(draft.create ? "workboard.newBoard" : "workboard.editBoard"),
      style: `--openclaw-modal-width: ${draft.sessions ? "640px" : "420px"}; --openclaw-modal-backdrop-filter: blur(1px);`,
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
          <h2>${t(draft.create ? "workboard.newBoard" : "workboard.editBoard")}</h2>
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
        ${
          draft.create
            ? html`<fieldset
                class="workboard-board-kind"
                ?disabled=${draft.saving || !props.canWrite}
              >
                <legend>${t("workboard.boardKind")}</legend>
                ${(["cards", "sessions"] as const).map(
                  (kind) =>
                    html`<label
                      ><input
                        type="radio"
                        name="board-kind"
                        value=${kind}
                        .checked=${draft.kind === kind}
                        @change=${() => {
                          draft.kind = kind;
                          props.requestUpdate();
                        }}
                      />${t(kind === "cards" ? "workboard.cardsBoard" : "workboard.sessionsBoard.kind")}</label
                    >`,
                )}
              </fieldset>`
            : nothing
        }
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
        ${draft.sessions ? renderSessionsEditor(draft, props.canWrite, props.requestUpdate) : nothing}
        ${draft.sessions && visibleError ? html`<div class="workboard-sessions__warning" role="alert">${visibleError}</div>` : nothing}
        <div class="workboard-modal__actions">
          <button class="btn" type="button" ?disabled=${draft.saving} @click=${props.onCancel}>
            ${t("common.cancel")}
          </button>
          <button
            class="btn primary"
            type="submit"
            ?disabled=${draft.saving || !props.client || !props.canWrite || !draft.name.trim()}
          >
            ${t(draft.create ? "common.create" : "common.save")}
          </button>
        </div>
      </form>
      ${renderWorkboardErrorToast(draft.error ? draft : props.toastOwner, visibleError)}`,
  );
}

function renderSessionsEditor(draft: BoardDraft, canWrite: boolean, requestUpdate: () => void) {
  const spec = draft.sessions;
  if (!spec) {
    return nothing;
  }
  const disabled = draft.saving || !canWrite;
  return html`<fieldset class="workboard-sessions-editor" ?disabled=${disabled}>
    <legend>${t("workboard.sessionsBoard.columns")}</legend>
    ${spec.columns.map(
      (column, index) => html`<div
        class="workboard-sessions-editor__column"
        data-column-id=${column.id}
      >
        <label
          ><span>${t("workboard.sessionsBoard.columnLabel")}</span
          ><input
            class="settings-input"
            required
            maxlength="60"
            aria-label=${t("workboard.sessionsBoard.columnLabel")}
            .value=${live(column.label)}
            @input=${(event: Event) => {
              if (event.currentTarget instanceof HTMLInputElement) {
                column.label = event.currentTarget.value;
                requestUpdate();
              }
            }}
        /></label>
        <label
          ><span>${t("workboard.boardColor")}</span
          ><select
            class="settings-input"
            aria-label=${t("workboard.boardColor")}
            .value=${column.color ?? ""}
            @change=${(event: Event) => {
              if (event.currentTarget instanceof HTMLSelectElement) {
                column.color = event.currentTarget.value || undefined;
                requestUpdate();
              }
            }}
          >
            <option value="">${t("workboard.sessionsBoard.defaultColor")}</option>
            ${["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"].map((color) => html`<option value=${color}>${t(`workboard.sessionsBoard.color.${color}`)}</option>`)}
          </select></label
        >
        <label class="workboard-sessions-editor__description"
          ><span>${t("workboard.sessionsBoard.description")}</span
          ><textarea
            class="settings-input"
            required
            maxlength="400"
            rows="2"
            aria-label=${t("workboard.sessionsBoard.description")}
            .value=${live(column.description)}
            @input=${(event: Event) => {
              if (event.currentTarget instanceof HTMLTextAreaElement) {
                column.description = event.currentTarget.value;
                requestUpdate();
              }
            }}
          ></textarea>
        </label>
        <label
          ><input
            type="radio"
            name="sessions-fallback"
            .checked=${Boolean(column.fallback)}
            @change=${() => {
              for (const entry of spec.columns) {
                entry.fallback = entry.id === column.id;
              }
              requestUpdate();
            }}
          />${t("workboard.sessionsBoard.fallback")}</label
        >
        <div class="workboard-sessions-editor__actions">
          ${[-1, 1].map(
            (offset) => html`<button
              class="btn"
              type="button"
              ?disabled=${disabled || index + offset < 0 || index + offset >= spec.columns.length}
              @click=${() => {
                spec.columns.splice(index, 1);
                spec.columns.splice(index + offset, 0, column);
                requestUpdate();
              }}
            >
              ${t(offset < 0 ? "workboard.sessionsBoard.moveUp" : "workboard.sessionsBoard.moveDown")}
            </button>`,
          )}
          <button
            class="btn"
            type="button"
            ?disabled=${disabled || spec.columns.length <= 2}
            @click=${() => {
              spec.columns.splice(index, 1);
              requestUpdate();
            }}
          >
            ${t("workboard.sessionsBoard.removeColumn")}
          </button>
        </div>
      </div>`,
    )}
    <button
      class="btn"
      type="button"
      ?disabled=${disabled || spec.columns.length >= 12}
      @click=${() => {
        spec.columns.push({
          id: `column-${crypto.randomUUID().slice(0, 8)}`,
          label: t("workboard.sessionsBoard.newColumn"),
          description: "",
        });
        requestUpdate();
      }}
    >
      ${icons.plus}${t("workboard.sessionsBoard.addColumn")}
    </button>
    <p class="workboard-sessions-editor__help">${t("workboard.sessionsBoard.rulesHelp")}</p>
  </fieldset>`;
}
