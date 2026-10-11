/** @jsxImportSource @solidjs/web */
import {
  normalizeWorkboardSessionsBoardSpec,
  type WorkboardSessionsBoardSpec,
} from "@openclaw/workboard-contract";
import { For, createEffect, onCleanup } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { AppearancePicker, Dialog } from "../../components/host-components.tsx";
import { icons } from "../../components/icons.tsx";
import { WorkboardErrorToast, updateWorkboardToastOutcome } from "../../components/toast.tsx";
import { WorkboardBoardGlyph } from "../../components/workboard-board-glyph.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { WorkboardBoardMetadata, WorkboardBoardSummary } from "../../lib/workboard/types.ts";
import { liveInputValue } from "./view-input-value.ts";

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

export function BoardModal(props: {
  revision?: number;
  draft: BoardDraft;
  pageError?: string | null;
  toastOwner: object;
  client: GatewayBrowserClient | null;
  readonly canWrite: boolean;
  onSaved: (board: WorkboardBoardMetadata) => void;
  onCancel: () => void;
  requestUpdate: () => void;
}) {
  const draft = () => {
    void props.revision;
    return props.draft;
  };
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const nameValue = liveInputValue(() => draft().name);
  const visibleError = () => draft().error ?? props.pageError;
  createEffect(
    () => ({ owner: draft(), error: draft().error }),
    ({ owner, error }) => {
      updateWorkboardToastOutcome(owner, { message: error ?? "", key: error, tone: "error" });
    },
  );
  const save = async () => {
    if (!props.client || !props.canWrite || draft().saving || !draft().name.trim()) {
      return;
    }
    const initialDraft = draft();
    const client = props.client;
    const isPresented = () => !disposed && props.draft === initialDraft;
    const isCurrent = () => isPresented() && props.client === client;
    let sessions: WorkboardSessionsBoardSpec | undefined;
    try {
      sessions = initialDraft.sessions
        ? normalizeWorkboardSessionsBoardSpec(initialDraft.sessions)
        : undefined;
    } catch (error) {
      initialDraft.error = formatUiError(error);
      props.requestUpdate();
      return;
    }
    const input: Record<string, string | string[]> = { id: initialDraft.id };
    if (initialDraft.create && initialDraft.kind === "sessions") {
      input.kind = "sessions";
    }
    const clearAppearance: string[] = [];
    const original = originals.get(initialDraft);
    for (const field of ["name", "icon", "color"] as const) {
      const value = initialDraft[field].trim();
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
    initialDraft.saving = true;
    initialDraft.error = null;
    props.requestUpdate();
    try {
      const { board } = await client.request<{ board: WorkboardBoardMetadata }>(
        "workboard.boards.upsert",
        input,
      );
      if (!isCurrent()) {
        return;
      }
      if (
        sessions &&
        JSON.stringify(initialDraft.sessions?.columns) !==
          JSON.stringify(original?.sessions?.columns)
      ) {
        if (!props.canWrite) {
          throw new Error(t("workboard.sessionsBoard.writeUnavailable"));
        }
        await client.request("workboard.sessionsBoard.update", {
          boardId: initialDraft.id,
          patch: { columns: sessions.columns },
        });
      }
      if (isCurrent()) {
        props.onSaved(board);
      }
    } catch (error) {
      if (isCurrent()) {
        initialDraft.error = formatUiError(error);
      }
    } finally {
      initialDraft.saving = false;
      if (isPresented()) {
        props.requestUpdate();
      }
    }
  };
  return (
    <Dialog
      {...{
        label: t(draft().create ? "workboard.newBoard" : "workboard.editBoard"),
        style: `--openclaw-modal-width: ${draft().sessions ? "640px" : "420px"}; --openclaw-modal-backdrop-filter: blur(1px);`,
        onCancel: () => {
          if (draft().saving) {
            return false;
          }
          props.onCancel();
          return true;
        },
      }}
    >
      <>
        <form
          class="workboard-draft workboard-board-draft"
          onSubmit={(event: SubmitEvent) => {
            event.preventDefault();
            void save();
          }}
        >
          <div class="workboard-modal__header">
            <h2>{t(draft().create ? "workboard.newBoard" : "workboard.editBoard")}</h2>
            <button
              class="btn btn--icon workboard-modal__close"
              type="button"
              aria-label={t("common.close")}
              disabled={draft().saving}
              onClick={() => props.onCancel()}
            >
              {icons.x}
            </button>
          </div>
          {draft().create ? (
            <fieldset class="workboard-board-kind" disabled={draft().saving || !props.canWrite}>
              <legend>{t("workboard.boardKind")}</legend>
              <For each={["cards", "sessions"] as const} keyed={(kind) => kind}>
                {(kind) => (
                  <label>
                    <input
                      type="radio"
                      name="board-kind"
                      value={kind()}
                      checked={draft().kind === kind()}
                      onChange={() => {
                        draft().kind = kind();
                        props.requestUpdate();
                      }}
                    />
                    {t(
                      kind() === "cards" ? "workboard.cardsBoard" : "workboard.sessionsBoard.kind",
                    )}
                  </label>
                )}
              </For>
            </fieldset>
          ) : undefined}
          <div class="workboard-board-draft__identity">
            <div class="workboard-board-draft__preview">
              <WorkboardBoardGlyph board={draft()} />
            </div>
            <label class="workboard-board-draft__name">
              <span>{t("workboard.boardName")}</span>
              <input
                class="settings-input"
                autofocus
                required
                maxlength="120"
                ref={nameValue}
                disabled={draft().saving || !props.canWrite}
                onInput={(event: Event) => {
                  if (!(event.currentTarget instanceof HTMLInputElement)) {
                    return;
                  }
                  draft().name = event.currentTarget.value;
                  props.requestUpdate();
                }}
              />
            </label>
          </div>
          <section
            class="workboard-board-draft__appearance"
            aria-label={t("workboard.boardAppearance")}
          >
            <AppearancePicker
              {...{
                icon: draft().icon || null,
                color: draft().color || null,
                disabled: draft().saving || !props.canWrite,
                clearable: true,
                onChange: ({ icon, color }) => {
                  draft().icon = icon ?? "";
                  draft().color = color ?? "";
                  props.requestUpdate();
                },
              }}
            />
          </section>
          {draft().sessions ? (
            <SessionsEditor
              draft={draft()}
              canWrite={props.canWrite}
              requestUpdate={props.requestUpdate}
              revision={props.revision}
            />
          ) : undefined}
          {draft().sessions && visibleError() ? (
            <div class="workboard-sessions__warning" role="alert">
              {visibleError()}
            </div>
          ) : undefined}
          <div class="workboard-modal__actions">
            <button
              class="btn"
              type="button"
              disabled={draft().saving}
              onClick={() => props.onCancel()}
            >
              {t("common.cancel")}
            </button>
            <button
              class="btn primary"
              type="submit"
              disabled={draft().saving || !props.client || !props.canWrite || !draft().name.trim()}
            >
              {t(draft().create ? "common.create" : "common.save")}
            </button>
          </div>
        </form>
        <WorkboardErrorToast
          owner={draft().error ? draft() : props.toastOwner}
          error={visibleError()}
        />
      </>
    </Dialog>
  );
}

function SessionsEditor(props: {
  draft: BoardDraft;
  canWrite: boolean;
  requestUpdate: () => void;
  revision?: number;
}) {
  const spec = () => {
    void props.revision;
    return props.draft.sessions!;
  };
  const disabled = () => {
    void props.revision;
    return props.draft.saving || !props.canWrite;
  };
  return (
    <fieldset class="workboard-sessions-editor" disabled={disabled()}>
      <legend>{t("workboard.sessionsBoard.columns")}</legend>
      <For each={[...spec().columns]} keyed={(column) => column.id}>
        {(column, index) => {
          const current = () => {
            void props.revision;
            return column();
          };
          const labelValue = liveInputValue(() => current().label);
          const descriptionValue = liveInputValue(() => current().description);
          const colorValue = liveInputValue(() => current().color ?? "");
          return (
            <div class="workboard-sessions-editor__column" data-column-id={current().id}>
              <label>
                <span>{t("workboard.sessionsBoard.columnLabel")}</span>
                <input
                  class="settings-input"
                  required
                  maxlength="60"
                  aria-label={t("workboard.sessionsBoard.columnLabel")}
                  ref={labelValue}
                  onInput={(event: Event) => {
                    if (event.currentTarget instanceof HTMLInputElement) {
                      current().label = event.currentTarget.value;
                      props.requestUpdate();
                    }
                  }}
                />
              </label>
              <label>
                <span>{t("workboard.boardColor")}</span>
                <select
                  class="settings-input"
                  aria-label={t("workboard.boardColor")}
                  ref={colorValue}
                  onChange={(event: Event) => {
                    if (event.currentTarget instanceof HTMLSelectElement) {
                      current().color = event.currentTarget.value || undefined;
                      props.requestUpdate();
                    }
                  }}
                >
                  <option value="">{t("workboard.sessionsBoard.defaultColor")}</option>
                  <For
                    each={["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"]}
                    keyed={(color) => color}
                  >
                    {(color) => (
                      <option value={color()}>
                        {t(`workboard.sessionsBoard.color.${color()}`)}
                      </option>
                    )}
                  </For>
                </select>
              </label>
              <label class="workboard-sessions-editor__description">
                <span>{t("workboard.sessionsBoard.description")}</span>
                <textarea
                  class="settings-input"
                  required
                  maxlength="400"
                  rows="2"
                  aria-label={t("workboard.sessionsBoard.description")}
                  ref={descriptionValue}
                  onInput={(event: Event) => {
                    if (event.currentTarget instanceof HTMLTextAreaElement) {
                      current().description = event.currentTarget.value;
                      props.requestUpdate();
                    }
                  }}
                />
              </label>
              <label>
                <input
                  type="radio"
                  name="sessions-fallback"
                  checked={Boolean(current().fallback)}
                  onChange={() => {
                    for (const entry of spec().columns) {
                      entry.fallback = entry.id === current().id;
                    }
                    props.requestUpdate();
                  }}
                />
                {t("workboard.sessionsBoard.fallback")}
              </label>
              <div class="workboard-sessions-editor__actions">
                <For each={[-1, 1]} keyed={(offset) => offset}>
                  {(offset) => (
                    <button
                      class="btn"
                      type="button"
                      disabled={
                        disabled() ||
                        index() + offset() < 0 ||
                        index() + offset() >= spec().columns.length
                      }
                      onClick={() => {
                        spec().columns.splice(index(), 1);
                        spec().columns.splice(index() + offset(), 0, current());
                        props.requestUpdate();
                      }}
                    >
                      {t(
                        offset() < 0
                          ? "workboard.sessionsBoard.moveUp"
                          : "workboard.sessionsBoard.moveDown",
                      )}
                    </button>
                  )}
                </For>
                <button
                  class="btn"
                  type="button"
                  disabled={disabled() || spec().columns.length <= 2}
                  onClick={() => {
                    spec().columns.splice(index(), 1);
                    props.requestUpdate();
                  }}
                >
                  {t("workboard.sessionsBoard.removeColumn")}
                </button>
              </div>
            </div>
          );
        }}
      </For>
      <button
        class="btn"
        type="button"
        disabled={disabled() || spec().columns.length >= 12}
        onClick={() => {
          spec().columns.push({
            id: `column-${crypto.randomUUID().slice(0, 8)}`,
            label: t("workboard.sessionsBoard.newColumn"),
            description: "",
          });
          props.requestUpdate();
        }}
      >
        {icons.plus}
        {t("workboard.sessionsBoard.addColumn")}
      </button>
      <p class="workboard-sessions-editor__help">{t("workboard.sessionsBoard.rulesHelp")}</p>
    </fieldset>
  );
}
