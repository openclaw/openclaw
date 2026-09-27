import { html, nothing } from "lit";
import { renderDialog, renderSelectPicker } from "../../components/host-components.ts";
import { icons } from "../../components/icons.ts";
import { renderWorkboardToast } from "../../components/toast.ts";
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
  renderPriorityIcon,
  formatStatusLabel,
  type WorkboardProps,
} from "./view-helpers.ts";

const KEEP_AGENT = "workboard:keep-agent";

type CardPatch = Partial<Pick<WorkboardCard, "priority" | "labels" | "agentId">>;
type SelectionAction =
  | { kind: "move"; status: WorkboardStatus }
  | { kind: "update"; patch: (card: WorkboardCard) => CardPatch }
  | { kind: "archive" | "delete" };

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
    (props.showAgentFilter === false ||
      matchesAgentFilter(card, props.agentsList, state.agentFilter))
  );
}

export function reconcileSelectionScope(props: WorkboardProps) {
  const state = getWorkboardState(props.host);
  const scope = JSON.stringify([
    state.boardFilter,
    props.scopeAgentId ?? null,
    props.agentsList?.defaultId ?? props.defaultAgentId ?? null,
    props.showAgentFilter === false ? null : state.agentFilter,
  ]);
  const previous = selectionScopes.get(props.host);
  if (previous !== undefined && previous !== scope) {
    state.selectedCardIds = new Set();
    state.bulkDialog = null;
    state.bulkResult = null;
  }
  selectionScopes.set(props.host, scope);
  const eligible = new Set(
    state.cards
      .filter((card) => isActiveWorkboardCard(card) && matchesWorkboardCardScope(props, card))
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
        host: props.host,
        client: props.client,
        cardId,
        expectedUpdatedAt: observed.updatedAt,
        requestUpdate: props.onRequestUpdate,
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
            (await updateWorkboardCardProperties({ ...common, card: observed, patch }));
          break;
        }
        case "archive":
          applied = await archiveWorkboardCard({ ...common, archived: true });
          break;
        case "delete": {
          const result = await deleteWorkboardCard(common);
          applied = Boolean(result);
          if (result) {
            for (const receipt of result.referenceUpdates ?? []) {
              const observation = observations.get(receipt.id);
              if (observation?.updatedAt === receipt.previousUpdatedAt) {
                observations.set(receipt.id, { ...observation, updatedAt: receipt.updatedAt });
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
    state.bulkResult = { completed, total: cardIds.length };
    if (state.error) {
      state.error = `${t("workboard.bulkResult", { completed: String(completed), total: String(cardIds.length) })} ${state.error}`;
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

function agentOptions(props: WorkboardProps) {
  return buildAssignableAgentPickerOptions(
    props.agentsList ?? null,
    "",
    props.agentsList?.defaultId ?? props.defaultAgentId ?? undefined,
  ).map((option) => Object.assign({}, option, { description: option.badge }));
}

export function renderSelectionActions(props: WorkboardProps) {
  const state = getWorkboardState(props.host);
  const cardIds = state.cards
    .filter((card) => state.selectedCardIds.has(card.id))
    .map((card) => card.id);
  const busy = state.loading || state.dispatching || workboardHasActiveWrites(state);
  const disabled = !canMutate(props) || !props.connected || busy;
  const openDialog = (kind: "edit" | "delete") => {
    state.error = null;
    const observedCards = state.cards.filter((card) => cardIds.includes(card.id));
    state.bulkDialog =
      kind === "delete"
        ? { kind, cardIds, observedCards }
        : {
            kind,
            cardIds,
            observedCards,
            priority: "",
            agentId: KEEP_AGENT,
            labels: "",
            labelMode: "keep",
          };
    props.onRequestUpdate?.();
  };
  return html`
    <div
      class="workboard-selection"
      role="group"
      aria-label=${t("workboard.selectionLabel")}
      aria-busy=${state.bulkSaving}
    >
      <span class="workboard-selection__count" role="status"
        >${t(cardIds.length === 1 ? "workboard.selectedCountOne" : "workboard.selectedCount", {
          count: String(cardIds.length),
        })}</span
      >
      ${renderSelectPicker(
        {
          value: "",
          accessibleLabel: t("workboard.bulkMoveLabel"),
          disabled,
          options: [
            { value: "", label: t("workboard.bulkMoveLabel"), disabled: true },
            ...state.statuses.map((status) => ({
              value: status,
              label: formatStatusLabel(status),
            })),
          ],
          onSelect: (value) => {
            const status = state.statuses.find((entry) => entry === value);
            if (status) {
              void applySelection(props, cardIds, { kind: "move", status });
            }
          },
        },
        "workboard-selection__picker",
      )}
      ${renderSelectPicker(
        {
          value: KEEP_AGENT,
          accessibleLabel: t("workboard.bulkAssign"),
          disabled,
          options: [
            { value: KEEP_AGENT, label: t("workboard.bulkAssign"), disabled: true },
            ...agentOptions(props),
          ],
          onSelect: (agentId) => {
            if (agentOptions(props).some((option) => option.value === agentId)) {
              void applySelection(props, cardIds, { kind: "update", patch: () => ({ agentId }) });
            }
          },
        },
        "workboard-selection__picker",
      )}
      <button class="btn" type="button" ?disabled=${disabled} @click=${() => openDialog("edit")}>
        ${icons.edit}<span>${t("workboard.bulkEdit")}</span>
      </button>
      <span class="workboard-selection__separator" aria-hidden="true"></span>
      <button
        class="btn"
        type="button"
        ?disabled=${disabled}
        @click=${() => void applySelection(props, cardIds, { kind: "archive" })}
      >
        ${icons.archive}<span>${t("workboard.bulkArchive")}</span>
      </button>
      <button
        class="btn workboard-selection__delete"
        type="button"
        ?disabled=${disabled}
        @click=${() => openDialog("delete")}
      >
        ${icons.trash}<span>${t("workboard.bulkDelete")}</span>
      </button>
      <button
        class="btn btn--icon workboard-selection__clear"
        type="button"
        title=${t("workboard.clearSelection")}
        aria-label=${t("workboard.clearSelection")}
        ?disabled=${busy}
        @click=${() => {
          state.selectedCardIds.clear();
          props.onRequestUpdate?.();
        }}
      >
        ${icons.x}
      </button>
    </div>
  `;
}

function editPatch(
  draft: Extract<WorkboardBulkDialog, { kind: "edit" }>,
  card: WorkboardCard,
): CardPatch {
  const patch: CardPatch = {};
  if (draft.priority) {
    patch.priority = draft.priority;
  }
  if (draft.agentId !== KEEP_AGENT) {
    patch.agentId = draft.agentId;
  }
  const labels = [
    ...new Set(
      draft.labels
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
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

export function renderSelectionDialog(props: WorkboardProps) {
  const state = getWorkboardState(props.host);
  const visibleError = workboardErrorMessage(state, props.pageError);
  const draft = state.bulkDialog;
  if (!draft) {
    return nothing;
  }
  const close = () => {
    if (state.bulkSaving) {
      return false;
    }
    state.bulkDialog = null;
    props.onRequestUpdate?.();
    return true;
  };
  const title = t(
    draft.kind === "delete" ? "workboard.bulkDeleteTitle" : "workboard.bulkEditTitle",
    { count: String(draft.cardIds.length) },
  );
  const changed =
    draft.kind === "delete" ||
    Boolean(draft.priority || draft.agentId !== KEEP_AGENT || draft.labelMode !== "keep");
  const save = () =>
    void applySelection(
      props,
      draft.cardIds,
      draft.kind === "delete"
        ? { kind: "delete" }
        : { kind: "update", patch: (card) => editPatch(draft, card) },
      draft.observedCards,
    );
  return renderDialog(
    {
      label: title,
      style: "--openclaw-modal-width: 460px; --openclaw-modal-backdrop-filter: none;",
      onCancel: close,
    },
    html`
      <form
        class="workboard-bulk-dialog"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          save();
        }}
      >
        <div class="workboard-modal__header">
          <h2>${title}</h2>
          <button
            class="btn btn--icon workboard-modal__close"
            type="button"
            aria-label=${t("common.close")}
            ?disabled=${state.bulkSaving}
            @click=${close}
          >
            ${icons.x}
          </button>
        </div>
        ${
          draft.kind === "delete"
            ? html`<p>${t("workboard.bulkDeleteHelp")}</p>`
            : html`
                <p>${t("workboard.bulkEditHelp")}</p>
                <fieldset
                  class="workboard-choice-field"
                  aria-labelledby="workboard-bulk-priority-label"
                  ?disabled=${state.bulkSaving}
                >
                  <legend>
                    <span id="workboard-bulk-priority-label">${t("workboard.fieldPriority")}</span>
                    <button
                      class="workboard-bulk-dialog__reset"
                      type="button"
                      ?disabled=${state.bulkSaving || !draft.priority}
                      @click=${() => {
                        draft.priority = "";
                        props.onRequestUpdate?.();
                      }}
                    >
                      ${t("workboard.bulkKeep")}
                    </button>
                  </legend>
                  <div class="workboard-segments workboard-segments--priority">
                    ${WORKBOARD_PRIORITIES.map(
                      (priority) => html`<label class="workboard-segment">
                        <input
                          type="radio"
                          name="bulk-priority"
                          .checked=${draft.priority === priority}
                          @change=${() => {
                            draft.priority = priority;
                            props.onRequestUpdate?.();
                          }}
                        />
                        <span
                          ><i aria-hidden="true">${renderPriorityIcon(priority)}</i
                          >${formatPriorityLabel(priority)}</span
                        >
                      </label>`,
                    )}
                  </div>
                </fieldset>
                <div class="field">
                  <span>${t("workboard.fieldAgent")}</span>
                  ${renderSelectPicker({
                    value: draft.agentId,
                    disabled: state.bulkSaving,
                    accessibleLabel: t("workboard.fieldAgent"),
                    options: [
                      { value: KEEP_AGENT, label: t("workboard.bulkKeep") },
                      ...agentOptions(props),
                    ],
                    onSelect: (value) => {
                      draft.agentId = value;
                      props.onRequestUpdate?.();
                    },
                  })}
                </div>
                <div class="field">
                  <span>${t("workboard.fieldLabels")}</span>
                  ${renderSelectPicker({
                    value: draft.labelMode,
                    disabled: state.bulkSaving,
                    accessibleLabel: t("workboard.fieldLabels"),
                    options: (["keep", "add", "replace", "remove"] as const).map((value) => ({
                      value,
                      label: t(`workboard.bulkLabels_${value}`),
                    })),
                    onSelect: (value) => {
                      draft.labelMode =
                        (["keep", "add", "replace", "remove"] as const).find(
                          (entry) => entry === value,
                        ) ?? "keep";
                      props.onRequestUpdate?.();
                    },
                  })}
                  ${
                    draft.labelMode === "keep"
                      ? nothing
                      : html`<input
                          class="settings-input"
                          aria-label=${t("workboard.fieldLabels")}
                          placeholder=${t("workboard.bulkLabelsPlaceholder")}
                          .value=${draft.labels}
                          ?disabled=${state.bulkSaving}
                          @input=${(event: InputEvent) => {
                            if (!(event.currentTarget instanceof HTMLInputElement)) {
                              return;
                            }
                            draft.labels = event.currentTarget.value;
                          }}
                        />`
                  }
                </div>
              `
        }
        <div class="workboard-modal__actions">
          <button class="btn" type="button" autofocus ?disabled=${state.bulkSaving} @click=${close}>
            ${t("common.cancel")}
          </button>
          <button
            class=${draft.kind === "delete" ? "btn danger" : "btn primary"}
            type="submit"
            ?disabled=${state.bulkSaving || !changed || !props.connected || !canMutate(props)}
          >
            ${
              state.bulkSaving
                ? t("workboard.bulkApplying")
                : t(draft.kind === "delete" ? "workboard.bulkDelete" : "workboard.bulkApply")
            }
          </button>
        </div>
      </form>
      ${renderWorkboardToast({
        owner: state,
        message: visibleError ?? "",
        key: visibleError,
        tone: "error",
      })}
    `,
  );
}
