/** @jsxImportSource @solidjs/web */
import { normalizeUniqueTrimmedStringList } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createMemo, For, Show } from "solid-js";
import { Dialog, SelectPicker } from "../../components/host-components.tsx";
import { icons } from "../../components/icons.tsx";
import { WorkboardErrorToast } from "../../components/toast.tsx";
import { workboardHost } from "../../host.ts";
import { t } from "../../i18n/index.ts";
import {
  isActiveWorkboardCard,
  nextWorkboardCardPosition,
} from "../../lib/workboard/card-state.ts";
import {
  archiveWorkboardCard,
  deleteWorkboardCard,
  moveWorkboardCard,
  updateWorkboardCardProperties,
} from "../../lib/workboard/mutations.ts";
import { getWorkboardState, workboardHasActiveWrites } from "../../lib/workboard/runtime.ts";
import {
  WORKBOARD_PRIORITIES,
  type WorkboardBulkDialog,
  type WorkboardCard,
  type WorkboardStatus,
} from "../../lib/workboard/types.ts";
import {
  buildAssignableAgentPickerOptions,
  matchesAgentScope,
  matchesAgentFilter,
} from "./agent-filter.ts";
import { matchesBoardFilter } from "./board-filter.ts";
import {
  canMutate,
  formatPriorityLabel,
  workboardErrorMessage,
  workboardMutationContext,
  PriorityIcon,
  formatStatusLabel,
  type WorkboardProps,
} from "./view-helpers.tsx";
import { liveInputValue } from "./view-input-value.ts";
const KEEP_AGENT = "workboard:keep-agent";
type CardPatch = Partial<Pick<WorkboardCard, "priority" | "labels" | "agentId">>;
type SelectionAction =
  | {
      kind: "move";
      status: WorkboardStatus;
    }
  | {
      kind: "update";
      patch: (card: WorkboardCard) => CardPatch;
    }
  | {
      kind: "archive" | "delete";
    };
const selectionScopes = new WeakMap<object, string>();
export function matchesWorkboardCardScope(props: WorkboardProps, card: WorkboardCard): boolean {
  const state = getWorkboardState(props.host);
  return (
    matchesBoardFilter(card, state.boardFilter) &&
    matchesAgentScope(
      card,
      props.agentsList?.defaultId ?? props.defaultAgentId,
      props.scopeAgentId,
    ) &&
    (props.showAgentFilter === false || matchesAgentFilter(card, state.agentFilter))
  );
}
export function reconcileSelectionScope(workboard: WorkboardProps) {
  const state = getWorkboardState(workboard.host);
  const scope = JSON.stringify([
    state.boardFilter,
    workboard.scopeAgentId ?? null,
    workboard.agentsList?.defaultId ?? workboard.defaultAgentId ?? null,
    workboard.showAgentFilter === false ? null : state.agentFilter,
  ]);
  const previous = selectionScopes.get(workboard.host);
  if (previous !== undefined && previous !== scope) {
    state.selectedCardIds = new Set();
    state.bulkDialog = null;
    state.bulkResult = null;
  }
  selectionScopes.set(workboard.host, scope);
  const eligible = new Set(
    state.cards
      .filter((card) => isActiveWorkboardCard(card) && matchesWorkboardCardScope(workboard, card))
      .map((card) => card.id),
  );
  for (const id of state.selectedCardIds) {
    if (!eligible.has(id)) {
      state.selectedCardIds.delete(id);
    }
  }
  if (state.bulkDialog) {
    state.bulkDialog.cardIds = state.bulkDialog.cardIds.filter((id) => eligible.has(id));
    if (!state.bulkDialog.cardIds.length) {
      state.bulkDialog = null;
    }
  }
}
async function applySelection(
  props: WorkboardProps,
  cardIds: string[],
  action: SelectionAction,
  observedCards = getWorkboardState(props.host).cards.filter((card) => cardIds.includes(card.id)),
) {
  const state = getWorkboardState(props.host);
  if (
    !props.client ||
    !props.connected ||
    !canMutate(props) ||
    state.loading ||
    state.dispatching ||
    workboardHasActiveWrites(state)
  ) {
    return;
  }
  const owner = workboardHost();
  const selection = state.selectedCardIds;
  const board = state.boardFilter;
  const agentScope = owner.agents.scopeId;
  const localAgent = state.agentFilter;
  const observations = new Map(observedCards.map((card) => [card.id, card]));
  state.bulkSaving = true;
  state.bulkResult = null;
  state.error = null;
  let completed = 0;
  props.onRequestUpdate?.();
  try {
    for (const cardId of cardIds) {
      if (
        selection !== state.selectedCardIds ||
        board !== state.boardFilter ||
        agentScope !== owner.agents.scopeId ||
        localAgent !== state.agentFilter ||
        owner.signal.aborted ||
        !owner.connection.connected ||
        !owner.connection.canWrite ||
        !canMutate(props)
      ) {
        state.error = t("workboard.bulkUnavailable");
        break;
      }
      const card = state.cards.find((entry) => entry.id === cardId);
      if (
        !card ||
        !isActiveWorkboardCard(card) ||
        !matchesWorkboardCardScope(props, card) ||
        !state.selectedCardIds.has(cardId)
      ) {
        selection.delete(cardId);
        continue;
      }
      const observed = observations.get(cardId);
      if (!observed) {
        state.error = t("workboard.bulkUnavailable");
        break;
      }
      const common = {
        ...workboardMutationContext(props),
        cardId,
        expectedUpdatedAt: observed.updatedAt,
      };
      let applied = false;
      switch (action.kind) {
        case "move":
          if (card.status !== action.status) {
            await moveWorkboardCard({
              ...common,
              status: action.status,
              position: nextWorkboardCardPosition(state.cards, card, action.status),
            });
          }
          applied =
            !state.error &&
            state.cards.find((entry) => entry.id === cardId)?.status === action.status;
          break;
        case "update": {
          const patch = action.patch(observed);
          applied =
            Object.keys(patch).length === 0 ||
            (await updateWorkboardCardProperties({
              ...common,
              card: observed,
              patch,
            }));
          break;
        }
        case "archive":
          applied = await archiveWorkboardCard({
            ...common,
            archived: true,
          });
          break;
        case "delete": {
          const result = await deleteWorkboardCard(common);
          applied = Boolean(result);
          if (result) {
            for (const receipt of result.referenceUpdates ?? []) {
              const observation = observations.get(receipt.id);
              if (observation?.updatedAt === receipt.previousUpdatedAt) {
                observations.set(receipt.id, {
                  ...observation,
                  updatedAt: receipt.updatedAt,
                });
              }
            }
          }
          break;
        }
      }
      if (!applied) {
        state.error ??= t("workboard.bulkUnavailable");
        break;
      }
      completed += 1;
      selection.delete(cardId);
    }
    if (selection !== state.selectedCardIds) {
      return;
    }
    state.bulkResult = {
      completed,
      total: cardIds.length,
    };
    if (state.error) {
      state.error = `${t("workboard.bulkResult", {
        completed: String(completed),
        total: String(cardIds.length),
      })} ${state.error}`;
      if (state.bulkDialog) {
        state.bulkDialog.cardIds = cardIds.filter((id) => state.selectedCardIds.has(id));
        state.bulkDialog.observedCards = state.cards.filter((card) =>
          state.bulkDialog?.cardIds.includes(card.id),
        );
      }
    } else {
      state.bulkDialog = null;
    }
  } finally {
    state.bulkSaving = false;
    props.onRequestUpdate?.();
  }
}
function agentOptions(workboard: WorkboardProps) {
  return buildAssignableAgentPickerOptions(
    workboard.agentsList ?? null,
    "",
    workboard.agentsList?.defaultId ?? workboard.defaultAgentId ?? undefined,
  ).map((option) =>
    Object.assign({}, option, {
      description: option.badge,
    }),
  );
}
export function SelectionActions(input: { workboard: WorkboardProps }) {
  const state = () => {
    void input.workboard.revision;
    return getWorkboardState(input.workboard.host);
  };
  const cardIds = createMemo(() =>
    state()
      .cards.filter((card) => state().selectedCardIds.has(card.id))
      .map((card) => card.id),
  );
  const busy = createMemo(
    () => state().loading || state().dispatching || workboardHasActiveWrites(state()),
  );
  const disabled = createMemo(
    () => !canMutate(input.workboard) || !input.workboard.connected || busy(),
  );
  const openDialog = (kind: "edit" | "delete") => {
    state().error = null;
    const observedCards = state().cards.filter((card) => cardIds().includes(card.id));
    state().bulkDialog =
      kind === "delete"
        ? {
            kind,
            cardIds: cardIds(),
            observedCards,
          }
        : {
            kind,
            cardIds: cardIds(),
            observedCards,
            priority: "",
            agentId: KEEP_AGENT,
            labels: "",
            labelMode: "keep",
          };
    input.workboard.onRequestUpdate?.();
  };
  return (
    <div
      class="workboard-selection"
      role="group"
      aria-label={t("workboard.selectionLabel")}
      aria-busy={state().bulkSaving ? "true" : "false"}
    >
      <span class="workboard-selection__count" role="status">
        {t(cardIds().length === 1 ? "workboard.selectedCountOne" : "workboard.selectedCount", {
          count: String(cardIds().length),
        })}
      </span>
      <SelectPicker
        {...{
          value: "",
          accessibleLabel: t("workboard.bulkMoveLabel"),
          disabled: disabled(),
          options: [
            {
              value: "",
              label: t("workboard.bulkMoveLabel"),
              disabled: true,
            },
            ...state().statuses.map((status) => ({
              value: status,
              label: formatStatusLabel(status),
            })),
          ],
          onSelect: (value) => {
            const status = state().statuses.find((entry) => entry === value);
            if (status) {
              void applySelection(input.workboard, cardIds(), {
                kind: "move",
                status,
              });
            }
          },
        }}
        class={"workboard-selection__picker"}
      />
      <SelectPicker
        {...{
          value: KEEP_AGENT,
          accessibleLabel: t("workboard.bulkAssign"),
          disabled: disabled(),
          options: [
            {
              value: KEEP_AGENT,
              label: t("workboard.bulkAssign"),
              disabled: true,
            },
            ...agentOptions(input.workboard),
          ],
          onSelect: (agentId) => {
            if (agentOptions(input.workboard).some((option) => option.value === agentId)) {
              void applySelection(input.workboard, cardIds(), {
                kind: "update",
                patch: () => ({
                  agentId,
                }),
              });
            }
          },
        }}
        class={"workboard-selection__picker"}
      />
      <button class="btn" type="button" disabled={disabled()} onClick={() => openDialog("edit")}>
        {icons.edit}
        <span>{t("workboard.bulkEdit")}</span>
      </button>
      <span class="workboard-selection__separator" aria-hidden="true" />
      <button
        class="btn"
        type="button"
        disabled={disabled()}
        onClick={() =>
          void applySelection(input.workboard, cardIds(), {
            kind: "archive",
          })
        }
      >
        {icons.archive}
        <span>{t("workboard.bulkArchive")}</span>
      </button>
      <button
        class="btn workboard-selection__delete"
        type="button"
        disabled={disabled()}
        onClick={() => openDialog("delete")}
      >
        {icons.trash}
        <span>{t("workboard.bulkDelete")}</span>
      </button>
      <button
        class="btn btn--icon workboard-selection__clear"
        type="button"
        title={t("workboard.clearSelection")}
        aria-label={t("workboard.clearSelection")}
        disabled={busy()}
        onClick={() => {
          state().selectedCardIds.clear();
          input.workboard.onRequestUpdate?.();
        }}
      >
        {icons.x}
      </button>
    </div>
  );
}
function editPatch(
  draft: Extract<
    WorkboardBulkDialog,
    {
      kind: "edit";
    }
  >,
  card: WorkboardCard,
): CardPatch {
  const patch: CardPatch = {};
  if (draft.priority) {
    patch.priority = draft.priority;
  }
  if (draft.agentId !== KEEP_AGENT) {
    patch.agentId = draft.agentId;
  }
  const labels = normalizeUniqueTrimmedStringList(draft.labels.split(","));
  switch (draft.labelMode) {
    case "keep":
      break;
    case "add":
      patch.labels = [...new Set([...card.labels, ...labels])];
      break;
    case "replace":
      patch.labels = labels;
      break;
    case "remove":
      patch.labels = card.labels.filter((label) => !labels.includes(label));
      break;
  }
  return patch;
}
export function SelectionDialog(props: { workboard: WorkboardProps }) {
  const draft = () => {
    void props.workboard.revision;
    return getWorkboardState(props.workboard.host).bulkDialog;
  };
  return (
    <Show when={draft()} keyed>
      {(current) => <SelectionDialogContent workboard={props.workboard} draft={current} />}
    </Show>
  );
}
function SelectionLabelsInput(props: {
  draft: Extract<
    WorkboardBulkDialog,
    {
      kind: "edit";
    }
  >;
  disabled: boolean;
}) {
  const bindValue = liveInputValue(() => props.draft.labels);
  return (
    <input
      class="settings-input"
      aria-label={t("workboard.fieldLabels")}
      placeholder={t("workboard.bulkLabelsPlaceholder")}
      ref={bindValue}
      disabled={props.disabled}
      onInput={(event: InputEvent) => {
        if (event.currentTarget instanceof HTMLInputElement) {
          props.draft.labels = event.currentTarget.value;
        }
      }}
    />
  );
}
function SelectionDialogContent(props: { workboard: WorkboardProps; draft: WorkboardBulkDialog }) {
  const state = () => {
    void props.workboard.revision;
    return getWorkboardState(props.workboard.host);
  };
  const draft = () => {
    void props.workboard.revision;
    return props.draft;
  };
  const editDraft = () => {
    const current = draft();
    return current.kind === "edit" ? current : undefined;
  };
  const title = () =>
    t(draft().kind === "delete" ? "workboard.bulkDeleteTitle" : "workboard.bulkEditTitle", {
      count: String(draft().cardIds.length),
    });
  const changed = () => {
    const current = draft();
    return (
      current.kind === "delete" ||
      Boolean(current.priority || current.agentId !== KEEP_AGENT || current.labelMode !== "keep")
    );
  };
  const close = () => {
    if (state().bulkSaving) {
      return false;
    }
    state().bulkDialog = null;
    props.workboard.onRequestUpdate?.();
    return true;
  };
  const save = () => {
    const current = draft();
    void applySelection(
      props.workboard,
      current.cardIds,
      current.kind === "delete"
        ? {
            kind: "delete",
          }
        : {
            kind: "update",
            patch: (card) => editPatch(current, card),
          },
      current.observedCards,
    );
  };
  return (
    <Dialog
      label={title()}
      style="--openclaw-modal-width: 460px; --openclaw-modal-backdrop-filter: none;"
      onCancel={close}
    >
      <form
        class="workboard-bulk-dialog"
        onSubmit={(event: SubmitEvent) => {
          event.preventDefault();
          save();
        }}
      >
        <div class="workboard-modal__header">
          <h2>{title()}</h2>
          <button
            class="btn btn--icon workboard-modal__close"
            type="button"
            aria-label={t("common.close")}
            disabled={state().bulkSaving}
            onClick={close}
          >
            {icons.x}
          </button>
        </div>
        <Show when={editDraft()} fallback={<p>{t("workboard.bulkDeleteHelp")}</p>}>
          {(current) => {
            const edit = () => {
              void props.workboard.revision;
              return current();
            };
            return (
              <>
                <p>{t("workboard.bulkEditHelp")}</p>
                <fieldset
                  class="workboard-choice-field"
                  aria-labelledby="workboard-bulk-priority-label"
                  disabled={state().bulkSaving}
                >
                  <legend>
                    <span id="workboard-bulk-priority-label">{t("workboard.fieldPriority")}</span>
                    <button
                      class="workboard-bulk-dialog__reset"
                      type="button"
                      disabled={state().bulkSaving || !edit().priority}
                      onClick={() => {
                        edit().priority = "";
                        props.workboard.onRequestUpdate?.();
                      }}
                    >
                      {t("workboard.bulkKeep")}
                    </button>
                  </legend>
                  <div class="workboard-segments workboard-segments--priority">
                    <For each={WORKBOARD_PRIORITIES} keyed={(priority) => priority}>
                      {(priority) => (
                        <label class="workboard-segment">
                          <input
                            type="radio"
                            name="bulk-priority"
                            checked={edit().priority === priority()}
                            onChange={() => {
                              edit().priority = priority();
                              props.workboard.onRequestUpdate?.();
                            }}
                          />
                          <span>
                            <i aria-hidden="true">
                              <PriorityIcon priority={priority()} />
                            </i>
                            {formatPriorityLabel(priority())}
                          </span>
                        </label>
                      )}
                    </For>
                  </div>
                </fieldset>
                <div class="field">
                  <span>{t("workboard.fieldAgent")}</span>
                  <SelectPicker
                    value={edit().agentId}
                    disabled={state().bulkSaving}
                    accessibleLabel={t("workboard.fieldAgent")}
                    options={[
                      {
                        value: KEEP_AGENT,
                        label: t("workboard.bulkKeep"),
                      },
                      ...agentOptions(props.workboard),
                    ]}
                    onSelect={(value) => {
                      edit().agentId = value;
                      props.workboard.onRequestUpdate?.();
                    }}
                  />
                </div>
                <div class="field">
                  <span>{t("workboard.fieldLabels")}</span>
                  <SelectPicker
                    value={edit().labelMode}
                    disabled={state().bulkSaving}
                    accessibleLabel={t("workboard.fieldLabels")}
                    options={(["keep", "add", "replace", "remove"] as const).map((value) => ({
                      value,
                      label: t(`workboard.bulkLabels_${value}`),
                    }))}
                    onSelect={(value) => {
                      edit().labelMode =
                        (["keep", "add", "replace", "remove"] as const).find(
                          (entry) => entry === value,
                        ) ?? "keep";
                      props.workboard.onRequestUpdate?.();
                    }}
                  />
                  <Show when={edit().labelMode !== "keep"}>
                    <SelectionLabelsInput draft={edit()} disabled={state().bulkSaving} />
                  </Show>
                </div>
              </>
            );
          }}
        </Show>
        <div class="workboard-modal__actions">
          <button class="btn" type="button" autofocus disabled={state().bulkSaving} onClick={close}>
            {t("common.cancel")}
          </button>
          <button
            class={draft().kind === "delete" ? "btn danger" : "btn primary"}
            type="submit"
            disabled={
              state().bulkSaving ||
              !changed() ||
              !props.workboard.connected ||
              !canMutate(props.workboard)
            }
          >
            {state().bulkSaving
              ? t("workboard.bulkApplying")
              : t(draft().kind === "delete" ? "workboard.bulkDelete" : "workboard.bulkApply")}
          </button>
        </div>
      </form>
      <WorkboardErrorToast
        owner={state()}
        error={workboardErrorMessage(state(), props.workboard.pageError)}
      />
    </Dialog>
  );
}
