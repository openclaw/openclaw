/** @jsxImportSource @solidjs/web */
import {
  normalizeWorkboardSessionsBoardSpec,
  WORKBOARD_EMPTY_COLUMN_MODES,
  WORKBOARD_STATUSES,
  type WorkboardCardsBoardColumns,
  type WorkboardEmptyColumnMode,
  type WorkboardSessionsBoardSpec,
  type WorkboardStatus,
} from "@openclaw/workboard-contract";
import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  For,
  Loading,
  onSettled,
} from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { AppearancePicker, Dialog } from "../../components/host-components.tsx";
import { icons } from "../../components/icons.tsx";
import { WorkboardErrorToast, WorkboardToast } from "../../components/toast.tsx";
import { WorkboardBoardGlyph } from "../../components/workboard-board-glyph.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatStatusLabel } from "../../lib/workboard/board-presentation.ts";
import type { WorkboardBoardMetadata, WorkboardBoardSummary } from "../../lib/workboard/types.ts";
import { liveInputValue } from "./view-input-value.ts";

/** Every status in display order; unchecked rows become the board's Other statuses. */
type CardsColumnsDraft = {
  rows: { status: WorkboardStatus; visible: boolean; label: string }[];
  emptyColumnMode: WorkboardEmptyColumnMode | "";
};

export type BoardDraft = {
  id: string;
  name: string;
  icon: string;
  color: string;
  kind: "cards" | "sessions";
  create?: boolean;
  sessions?: WorkboardSessionsBoardSpec;
  columns: CardsColumnsDraft;
};
const originals = new WeakMap<
  BoardDraft,
  Pick<BoardDraft, "name" | "icon" | "color" | "sessions"> & { columns: string }
>();

function createColumnsDraft(columns?: WorkboardCardsBoardColumns): CardsColumnsDraft {
  const visible = columns?.visible ?? WORKBOARD_STATUSES;
  return {
    rows: [...visible, ...WORKBOARD_STATUSES.filter((status) => !visible.includes(status))].map(
      (status) => ({
        status,
        visible: visible.includes(status),
        label: columns?.labels?.[status] ?? "",
      }),
    ),
    emptyColumnMode: columns?.emptyColumnMode ?? "",
  };
}

/** The upsert value for a columns draft; null when it matches the default presentation. */
function columnsInput(draft: CardsColumnsDraft): WorkboardCardsBoardColumns | null {
  const visible = draft.rows.filter((row) => row.visible).map((row) => row.status);
  const labels = Object.fromEntries(
    draft.rows.flatMap((row) => (row.label.trim() ? [[row.status, row.label.trim()]] : [])),
  );
  const isDefault =
    visible.length === WORKBOARD_STATUSES.length &&
    visible.every((status, index) => status === WORKBOARD_STATUSES[index]) &&
    Object.keys(labels).length === 0 &&
    !draft.emptyColumnMode;
  return isDefault
    ? null
    : {
        visible,
        ...(Object.keys(labels).length ? { labels } : {}),
        ...(draft.emptyColumnMode ? { emptyColumnMode: draft.emptyColumnMode } : {}),
      };
}

export function createBoardDraft(board: WorkboardBoardSummary): BoardDraft {
  const fields = { name: board.name ?? board.id, icon: board.icon ?? "", color: board.color ?? "" };
  const draft: BoardDraft = {
    id: board.id,
    ...fields,
    kind: board.kind ?? "cards",
    ...(board.sessions ? { sessions: structuredClone(board.sessions) } : {}),
    columns: createColumnsDraft(board.columns),
  };
  originals.set(draft, {
    ...fields,
    sessions: structuredClone(draft.sessions),
    columns: JSON.stringify(columnsInput(draft.columns)),
  });
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
    columns: createColumnsDraft(),
  };
  originals.set(draft, { name: "", icon: "", color: "", columns: JSON.stringify(null) });
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
  onChange: () => void;
}) {
  const initialActiveElement = document.activeElement;
  const initialReturnFocusTarget =
    initialActiveElement instanceof HTMLElement && initialActiveElement !== document.body
      ? initialActiveElement
      : undefined;
  const draft = () => {
    void props.revision;
    return props.draft;
  };
  let disposed = false;
  let busy = false;
  const [saving, setSaving] = createOptimistic(false);
  const [completion, setCompletion] = createSignal<Promise<void>>();
  const completed = createMemo(() => completion()?.then(() => null) ?? null);
  const presentSaving = action(function* (pending: Promise<void>) {
    setSaving(true);
    yield pending;
  });
  onSettled(() => () => {
    disposed = true;
  });
  const nameValue = liveInputValue(() => draft().name);
  const canSubmit = () =>
    Boolean(draft().name.trim()) &&
    (draft().kind !== "cards" || draft().columns.rows.some((row) => row.visible));
  const persist = async (initialDraft: BoardDraft, client: GatewayBrowserClient) => {
    busy = true;
    const isCurrent = () => !disposed && props.client === client;
    try {
      const sessions = initialDraft.sessions
        ? normalizeWorkboardSessionsBoardSpec(initialDraft.sessions)
        : undefined;
      const input: Record<string, unknown> = { id: initialDraft.id };
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
      const columns = columnsInput(initialDraft.columns);
      if (initialDraft.kind === "cards" && JSON.stringify(columns) !== original?.columns) {
        input.columns = columns;
      }
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
        throw error;
      }
    } finally {
      busy = false;
    }
  };
  const save = async () => {
    if (!props.client || !props.canWrite || busy || !canSubmit()) {
      return;
    }
    const pending = persist(draft(), props.client);
    // A disconnected or disposed view must still consume its admitted write.
    void pending.catch(() => undefined);
    void setCompletion(pending);
    // Publish the new outcome before the saving transition can hold it.
    await Promise.resolve();
    if (!disposed) {
      await presentSaving(pending).catch(() => undefined);
    }
  };
  return (
    <Dialog
      {...{
        label: t(draft().create ? "workboard.newBoard" : "workboard.editBoard"),
        returnFocusTarget: initialReturnFocusTarget,
        style: `--openclaw-modal-width: ${draft().sessions ? "640px" : draft().kind === "cards" ? "480px" : "420px"}; --openclaw-modal-backdrop-filter: blur(1px);`,
        onCancel: () => {
          if (busy) {
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
              disabled={saving()}
              onClick={() => props.onCancel()}
            >
              {icons.x}
            </button>
          </div>
          {draft().create ? (
            <fieldset class="workboard-board-kind" disabled={saving() || !props.canWrite}>
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
                        props.onChange();
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
                disabled={saving() || !props.canWrite}
                onInput={(event) => {
                  draft().name = event.currentTarget.value;
                  props.onChange();
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
                clearable: true,
                onChange: ({ icon, color }) => {
                  draft().icon = icon ?? "";
                  draft().color = color ?? "";
                  props.onChange();
                },
              }}
              disabled={saving() || !props.canWrite}
            />
          </section>
          {draft().kind === "cards" ? (
            <CardsColumnsEditor
              draft={draft()}
              disabled={saving() || !props.canWrite}
              onChange={props.onChange}
              revision={props.revision}
            />
          ) : undefined}
          {draft().sessions ? (
            <SessionsEditor
              draft={draft()}
              canWrite={props.canWrite}
              saving={saving()}
              onChange={props.onChange}
              revision={props.revision}
            />
          ) : undefined}
          {draft().sessions ? (
            <Loading
              on={completion()}
              fallback={
                props.pageError && (
                  <div class="workboard-sessions__warning" role="alert">
                    {props.pageError}
                  </div>
                )
              }
            >
              <Errored
                fallback={(error) => (
                  <div class="workboard-sessions__warning" role="alert">
                    {formatUiError(error())}
                  </div>
                )}
              >
                {completed()}
                {props.pageError && (
                  <div class="workboard-sessions__warning" role="alert">
                    {props.pageError}
                  </div>
                )}
              </Errored>
            </Loading>
          ) : undefined}
          <openclaw-modal-actions class="workboard-modal__actions">
            <button class="btn" type="button" disabled={saving()} onClick={() => props.onCancel()}>
              {t("common.cancel")}
            </button>
            <button
              class="btn primary"
              type="submit"
              disabled={saving() || !props.client || !props.canWrite || !canSubmit()}
            >
              {t(draft().create ? "common.create" : "common.save")}
            </button>
          </openclaw-modal-actions>
        </form>
        <Loading
          on={completion()}
          fallback={<WorkboardErrorToast owner={props.toastOwner} error={props.pageError} />}
        >
          <Errored
            fallback={(error) => (
              <WorkboardToast
                owner={draft()}
                message={formatUiError(error())}
                key={completion()}
                tone="error"
                outcomeSource
              />
            )}
          >
            {completed()}
            <WorkboardErrorToast owner={props.toastOwner} error={props.pageError} />
          </Errored>
        </Loading>
      </>
    </Dialog>
  );
}

function SessionsEditor(props: {
  draft: BoardDraft;
  canWrite: boolean;
  saving: boolean;
  onChange: () => void;
  revision?: number;
}) {
  const spec = () => {
    void props.revision;
    return props.draft.sessions!;
  };
  const disabled = () => {
    void props.revision;
    return props.saving || !props.canWrite;
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
                  onInput={(event) => {
                    current().label = event.currentTarget.value;
                    props.onChange();
                  }}
                />
              </label>
              <label>
                <span>{t("workboard.boardColor")}</span>
                <select
                  class="settings-input"
                  aria-label={t("workboard.boardColor")}
                  ref={colorValue}
                  onChange={(event) => {
                    current().color = event.currentTarget.value || undefined;
                    props.onChange();
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
                  onInput={(event) => {
                    current().description = event.currentTarget.value;
                    props.onChange();
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
                    props.onChange();
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
                        props.onChange();
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
                    props.onChange();
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
          props.onChange();
        }}
      >
        {icons.plus}
        {t("workboard.sessionsBoard.addColumn")}
      </button>
      <p class="workboard-sessions-editor__help">{t("workboard.sessionsBoard.rulesHelp")}</p>
    </fieldset>
  );
}

function CardsColumnsEditor(props: {
  draft: BoardDraft;
  disabled: boolean;
  onChange: () => void;
  revision?: number;
}) {
  const columns = () => {
    void props.revision;
    return props.draft.columns;
  };
  const emptyModeValue = liveInputValue(() => columns().emptyColumnMode);
  // Only shown columns have an order to change, so a move skips unchecked rows.
  const moveTarget = (index: number, offset: number) => {
    const rows = columns().rows;
    for (let target = index + offset; target >= 0 && target < rows.length; target += offset) {
      if (rows[target]!.visible) {
        return target;
      }
    }
    return undefined;
  };
  const move = (index: number, offset: number) => {
    const target = moveTarget(index, offset);
    if (target === undefined) {
      return;
    }
    const rows = columns().rows;
    const [row] = rows.splice(index, 1);
    rows.splice(target, 0, row!);
    props.onChange();
  };
  return (
    <fieldset class="workboard-columns-editor" disabled={props.disabled}>
      <legend>{t("workboard.boardColumns.title")}</legend>
      <p class="workboard-columns-editor__help">{t("workboard.boardColumns.help")}</p>
      <ol class="workboard-columns-editor__rows">
        <For each={[...columns().rows]} keyed={(row) => row.status}>
          {(row, index) => {
            const status = () => formatStatusLabel(row().status);
            const labelValue = liveInputValue(() => row().label);
            return (
              <li
                class={[
                  "workboard-columns-editor__row",
                  { "workboard-columns-editor__row--hidden": !row().visible },
                ]}
                data-status={row().status}
              >
                <input
                  type="checkbox"
                  checked={row().visible}
                  aria-label={t("workboard.boardColumns.show", { status: status() })}
                  onChange={(event) => {
                    row().visible = event.currentTarget.checked;
                    props.onChange();
                  }}
                />
                <span class="workboard-columns-editor__status">
                  <span
                    class={["workboard-status-dot", `workboard-status-dot--${row().status}`]}
                    aria-hidden="true"
                  />
                  {status()}
                </span>
                <input
                  class="settings-input"
                  maxlength="40"
                  placeholder={status()}
                  aria-label={t("workboard.boardColumns.label", { status: status() })}
                  ref={labelValue}
                  onInput={(event) => {
                    row().label = event.currentTarget.value;
                    props.onChange();
                  }}
                />
                <For each={[-1, 1]} keyed={(offset) => offset}>
                  {(offset) => (
                    <button
                      class={[
                        "btn btn--icon workboard-columns-editor__move",
                        { "workboard-columns-editor__move--up": offset() < 0 },
                      ]}
                      type="button"
                      aria-label={t(
                        offset() < 0
                          ? "workboard.boardColumns.moveUp"
                          : "workboard.boardColumns.moveDown",
                        { status: status() },
                      )}
                      disabled={
                        props.disabled ||
                        !row().visible ||
                        moveTarget(index(), offset()) === undefined
                      }
                      onClick={() => move(index(), offset())}
                    >
                      {icons.chevronDown}
                    </button>
                  )}
                </For>
              </li>
            );
          }}
        </For>
      </ol>
      <div class="workboard-columns-editor__footer">
        <label>
          <span>{t("workboard.boardColumns.emptyColumns")}</span>
          <select
            class="settings-input"
            ref={emptyModeValue}
            onChange={(event) => {
              const value = event.currentTarget.value;
              columns().emptyColumnMode =
                WORKBOARD_EMPTY_COLUMN_MODES.find((mode) => mode === value) ?? "";
              props.onChange();
            }}
          >
            <option value="">{t("workboard.emptyColumnsShow")}</option>
            <option value="collapse">{t("workboard.emptyColumnsCollapse")}</option>
            <option value="hide">{t("workboard.emptyColumnsHide")}</option>
          </select>
        </label>
        <button
          class="btn"
          type="button"
          onClick={() => {
            props.draft.columns = createColumnsDraft();
            props.onChange();
          }}
        >
          {t("workboard.boardColumns.reset")}
        </button>
      </div>
    </fieldset>
  );
}
