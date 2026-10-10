/** @jsxImportSource @solidjs/web */
import { For, Show, createSignal } from "solid-js";
import { AgentPicker, Dialog, SelectPicker } from "../../components/host-components.tsx";
import { icons } from "../../components/icons.tsx";
import { WorkboardErrorToast } from "../../components/toast.tsx";
import { t } from "../../i18n/index.ts";
import {
  changedDraftPayload,
  draftPayload,
  workboardCardSessionKey,
} from "../../lib/workboard/card-state.ts";
import {
  addWorkboardCardComment,
  getWorkboardState,
  resetDraftState,
  saveWorkboardCardDraft,
  WORKBOARD_PRIORITIES,
  type WorkboardCard,
  type WorkboardPriority,
  type WorkboardStatus,
  type WorkboardTemplateId,
  type WorkboardUiState,
} from "../../lib/workboard/index.ts";
import { buildAssignableAgentPickerOptions } from "./agent-filter.ts";
import {
  canMutate,
  formatPriorityLabel,
  workboardErrorMessage,
  workboardMutationContext,
  renderPriorityIcon,
  formatStatusLabel,
  isWorkboardSessionChoice,
  type WorkboardProps,
} from "./view-helpers.tsx";
import { liveInputValue } from "./view-input-value.ts";
import type { WorkboardSelectOption } from "./workboard-select.ts";

const workboardCardModalTitleId = "workboard-card-modal-title";
const workboardCardModalDescriptionId = "workboard-card-modal-description";
export const workboardCardModalId = "workboard-card-modal";
const initialDrafts = new WeakMap<WorkboardUiState, string>();

function draftFingerprint(state: WorkboardUiState): string {
  const payload = draftPayload(state);
  return JSON.stringify({ ...payload, title: payload.title.trim(), notes: payload.notes.trim() });
}

// Keep keystrokes in the form's presentation scope while updating the draft owner
// synchronously for dismissal and submission.
function syncDraftTextInput(
  state: WorkboardUiState,
  input: HTMLInputElement | HTMLTextAreaElement,
) {
  if (input.classList.contains("workboard-draft__title")) {
    state.draftTitle = input.value;
  } else if (input.classList.contains("workboard-draft__notes")) {
    state.draftNotes = input.value;
  } else if (input.classList.contains("workboard-draft__labels")) {
    state.draftLabels = input.value;
  } else if (input.classList.contains("workboard-comments__input")) {
    state.draftCommentBody = input.value;
  } else {
    return false;
  }

  return true;
}

function defineTemplate(
  id: WorkboardTemplateId,
  draftKey: string,
  labels: string,
  priority: WorkboardPriority,
) {
  return { id, draftKey, labels, priority };
}

const workboardTemplates = [
  defineTemplate("bugfix", "bugfix", "fix, test", "high"),
  defineTemplate("docs", "docs", "docs", "normal"),
  defineTemplate("release", "release", "release", "urgent"),
  defineTemplate("pr_review", "prReview", "review", "normal"),
  defineTemplate("plugin", "plugin", "plugin", "normal"),
];

export function openCreateModal(
  state: WorkboardUiState,
  props: Pick<WorkboardProps, "agentsList" | "defaultAgentId" | "scopeAgentId">,
  status: WorkboardStatus = "todo",
) {
  resetDraftState(state);
  state.draftStatus = status;
  const scopedAgentId = props.scopeAgentId?.trim();
  const defaultAgentId = props.agentsList?.defaultId?.trim() ?? props.defaultAgentId?.trim();
  const selectedAgentId = scopedAgentId
    ? scopedAgentId === defaultAgentId
      ? ""
      : scopedAgentId
    : state.agentFilter === "all" || state.agentFilter === "default"
      ? ""
      : state.agentFilter;
  if (
    selectedAgentId &&
    (props.agentsList
      ? buildAssignableAgentPickerOptions(props.agentsList, "").some(
          (agent) => agent.value === selectedAgentId,
        )
      : Boolean(scopedAgentId))
  ) {
    state.draftAgentId = selectedAgentId;
  }
  initialDrafts.set(state, draftFingerprint(state));
  state.draftOpen = true;
}

export function openEditModal(state: WorkboardUiState, card: WorkboardCard) {
  state.draftDiscardOpen = false;
  state.draftOpen = true;
  state.editingCardId = card.id;
  state.editingCardBase = card;
  state.draftTitle = card.title;
  state.draftNotes = card.notes ?? "";
  state.draftStatus = card.status;
  state.draftPriority = card.priority;
  state.draftLabels = card.labels.join(", ");
  state.draftAgentId = card.agentId ?? "";
  state.draftSessionKey = workboardCardSessionKey(card) ?? "";
  state.draftTemplateId = card.metadata?.templateId ?? "";
  state.draftCommentBody = "";
}

function applyTemplate(state: WorkboardUiState, templateId: WorkboardTemplateId) {
  const template = workboardTemplates.find((entry) => entry.id === templateId);
  if (!template) {
    return;
  }
  state.draftTemplateId = template.id;
  state.draftTitle = t(`workboard.templateDraft.${template.draftKey}Title`);
  state.draftNotes = t(`workboard.templateDraft.${template.draftKey}Notes`);
  state.draftLabels = template.labels;
  state.draftPriority = template.priority;
}

function DraftChoices<Value extends string>(params: {
  name: "status" | "priority";
  label: string;
  value: Value;
  options: readonly WorkboardSelectOption<Value>[];
  renderIcon?: (value: Value) => import("@solidjs/web").JSX.Element;
  disabled: boolean;
  onChange: (value: Value) => void;
}) {
  return (
    <fieldset
      class={["workboard-choice-field", { "workboard-field--wide": params.name === "status" }]}
      disabled={params.disabled}
    >
      <legend>{params.label}</legend>
      <div class={`workboard-segments workboard-segments--${params.name}`}>
        <For each={params.options} keyed={(option) => option.value}>
          {(option) => (
            <label
              class={[
                "workboard-segment",
                { [`workboard-segment--${option().value}`]: params.name === "status" },
              ]}
            >
              <input
                type="radio"
                name={params.name}
                value={option().value}
                checked={params.value === option().value}
                onChange={() => params.onChange(option().value)}
              />
              <span>
                {params.renderIcon ? (
                  <i aria-hidden="true">{params.renderIcon(option().value)}</i>
                ) : undefined}
                {option().label}
              </span>
            </label>
          )}
        </For>
      </div>
    </fieldset>
  );
}

export function CardModal(props: WorkboardProps) {
  const open = () => {
    void props.revision;
    return getWorkboardState(props.host).draftOpen;
  };
  return (
    <Show when={open()}>
      <CardModalContent {...props} />
    </Show>
  );
}

function CardModalContent(props: WorkboardProps) {
  const initialActiveElement = document.activeElement;
  const initialReturnFocusTarget =
    initialActiveElement instanceof HTMLElement && initialActiveElement !== document.body
      ? initialActiveElement
      : undefined;
  const [draftRevision, setDraftRevision] = createSignal(0);
  const state = () => {
    void props.revision;
    return getWorkboardState(props.host);
  };
  const draftTitle = () => {
    draftRevision();
    return state().draftTitle;
  };
  const commentBody = () => {
    draftRevision();
    return state().draftCommentBody;
  };
  const titleValue = liveInputValue(draftTitle);
  const notesValue = liveInputValue(() => state().draftNotes);
  const labelsValue = liveInputValue(() => state().draftLabels);
  const commentValue = liveInputValue(commentBody);
  const visibleError = () => workboardErrorMessage(state(), props.pageError);
  const sessions = () => props.sessions.filter(isWorkboardSessionChoice);
  const statusOptions = () =>
    state().statuses.map((status) => ({
      value: status,
      label: formatStatusLabel(status),
    }));
  const priorityOptions = () =>
    WORKBOARD_PRIORITIES.map((priority) => ({
      value: priority,
      label: formatPriorityLabel(priority),
    }));
  const defaultAgentId = () => props.agentsList?.defaultId ?? props.defaultAgentId ?? "";
  const assignableAgentOptions = () =>
    buildAssignableAgentPickerOptions(props.agentsList, state().draftAgentId, defaultAgentId());
  const sessionOptions = () => {
    const options = [
      { value: "", label: t("workboard.noLinkedSession") },
      ...sessions().map((session) => ({
        value: session.key,
        label: session.displayName ?? session.label ?? session.key,
        description: session.displayName || session.label ? session.key : undefined,
      })),
    ];
    if (
      state().draftSessionKey &&
      !options.some((option) => option.value === state().draftSessionKey)
    ) {
      options.push({ value: state().draftSessionKey, label: state().draftSessionKey });
    }
    return options;
  };
  const editing = () => Boolean(state().editingCardId);
  const editingCard = () =>
    state().editingCardId
      ? (state().cards.find((card) => card.id === state().editingCardId) ?? null)
      : null;
  const comments = () => [...(editingCard()?.metadata?.comments ?? [])];
  const draftCommentBusy = () => editing() && state().busyCardIds.has(state().editingCardId ?? "");
  const draftActionsBusy = () =>
    !canMutate(props) ||
    state().loading ||
    state().dispatching ||
    state().draftSaving ||
    draftCommentBusy();
  // Save completion resets this shared draft. Lock every edit and dismissal path
  // only for that write so stale drafts can still use Cancel to recover readiness.
  const draftDismissalBusy = () => state().draftSaving;
  const dismissDraft = () => {
    if (draftDismissalBusy()) {
      return false;
    }
    const changed =
      state().draftCommentBody.trim() ||
      (editing()
        ? Object.keys(changedDraftPayload(state())).length > 0
        : draftFingerprint(state()) !== initialDrafts.get(state()));
    if (changed) {
      state().draftDiscardOpen = true;
      props.onRequestUpdate?.();
      return false;
    }
    resetDraftState(state());
    props.onRequestUpdate?.();
    return true;
  };
  const draftDialog = (
    <Dialog
      {...{
        returnFocusTarget: initialReturnFocusTarget,
        label: editing() ? t("workboard.editCard") : t("workboard.newCard"),
        description: editing() ? t("workboard.editCardHelp") : t("workboard.newCardHelp"),
        style:
          "--openclaw-modal-width: 700px; --openclaw-modal-max-height: calc(100dvh - 40px); --openclaw-modal-backdrop-filter: blur(1px); --wa-color-overlay-modal: rgba(0, 0, 0, 0.32);",
        onCancel: dismissDraft,
      }}
    >
      <>
        <form
          id={workboardCardModalId}
          class="workboard-draft workboard-card-draft"
          aria-busy={draftActionsBusy() ? "true" : "false"}
          onInput={(event: InputEvent) => {
            const input = event.target;
            if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
              if (syncDraftTextInput(state(), input)) {
                setDraftRevision((revision) => revision + 1);
              }
            }
          }}
          onSubmit={(event: SubmitEvent) => {
            event.preventDefault();
            if (draftActionsBusy()) {
              return;
            }
            void saveWorkboardCardDraft(workboardMutationContext(props));
          }}
        >
          <div class="workboard-modal__header">
            <div>
              <h2 id={workboardCardModalTitleId}>
                {editing() ? t("workboard.editCard") : t("workboard.newCard")}
              </h2>
              <p id={workboardCardModalDescriptionId} class="workboard-draft__accessible-label">
                {editing() ? t("workboard.editCardHelp") : t("workboard.newCardHelp")}
              </p>
            </div>
            <span title={t("common.cancel")}>
              <button
                class="btn btn--icon workboard-modal__close"
                type="button"
                aria-label={t("common.cancel")}
                disabled={draftDismissalBusy()}
                onClick={dismissDraft}
              >
                {icons.x}
              </button>
            </span>
          </div>
          <div class="workboard-draft__body">
            <div class="workboard-draft__main">
              <label class="workboard-field">
                <span class="workboard-draft__accessible-label">{t("workboard.fieldTitle")}</span>
                <input
                  class="settings-input workboard-draft__title"
                  autofocus
                  placeholder={t("workboard.titlePlaceholder")}
                  disabled={draftActionsBusy()}
                  ref={titleValue}
                />
              </label>
              {!editing() ? (
                <div class="workboard-template-strip" aria-label={t("workboard.templatesLabel")}>
                  <span class="workboard-template-strip__label">
                    {t("workboard.suggestionsLabel")}
                  </span>
                  <For each={workboardTemplates} keyed={(template) => template.id}>
                    {(template) => (
                      <button
                        class="workboard-template-strip__suggestion"
                        type="button"
                        disabled={draftActionsBusy()}
                        onClick={() => {
                          applyTemplate(state(), template().id);
                          props.onRequestUpdate?.();
                        }}
                      >
                        {icons.plus} {t(`workboard.template.${template().id}`)}
                      </button>
                    )}
                  </For>
                </div>
              ) : undefined}
              <label class="workboard-field">
                <span class="workboard-draft__accessible-label">{t("workboard.fieldNotes")}</span>
                <textarea
                  class="settings-input workboard-draft__notes"
                  rows="3"
                  placeholder={t("workboard.notesPlaceholder")}
                  disabled={draftActionsBusy()}
                  ref={notesValue}
                />
              </label>
            </div>
            <div class="workboard-draft__meta">
              <DraftChoices<WorkboardStatus>
                {...{
                  name: "status",
                  value: state().draftStatus,
                  options: statusOptions(),
                  label: t("workboard.fieldStatus"),
                  onChange: (value) => {
                    state().draftStatus = value;
                    props.onRequestUpdate?.();
                  },
                  disabled: draftActionsBusy(),
                }}
              />
              <div class="workboard-field">
                <span>{t("workboard.fieldAgent")}</span>
                <AgentPicker
                  {...{
                    options: assignableAgentOptions(),
                    value: state().draftAgentId,
                    accessibleLabel: t("workboard.fieldAgent"),
                    disabled: draftActionsBusy(),
                    onSelect: (value: string) => {
                      state().draftAgentId = value;
                      props.onRequestUpdate?.();
                    },
                  }}
                  class="workboard-agent-select"
                />
              </div>
              <div class="workboard-field">
                <span>{t("workboard.fieldSession")}</span>
                <SelectPicker
                  {...{
                    value: state().draftSessionKey,
                    options: sessionOptions(),
                    accessibleLabel: t("workboard.fieldSession"),
                    searchable: true,
                    onSelect: (value) => {
                      state().draftSessionKey = value;
                      props.onRequestUpdate?.();
                    },
                    disabled: draftActionsBusy(),
                  }}
                  class="workboard-session-select"
                />
              </div>
              <DraftChoices<WorkboardPriority>
                {...{
                  name: "priority",
                  value: state().draftPriority,
                  options: priorityOptions(),
                  renderIcon: renderPriorityIcon,
                  label: t("workboard.fieldPriority"),
                  onChange: (value) => {
                    state().draftPriority = value;
                    props.onRequestUpdate?.();
                  },
                  disabled: draftActionsBusy(),
                }}
              />
              <label class="workboard-field">
                <span>{t("workboard.fieldLabels")}</span>
                <input
                  class="settings-input workboard-draft__labels"
                  spellcheck="false"
                  placeholder={t("workboard.labelsPlaceholder")}
                  disabled={draftActionsBusy()}
                  ref={labelsValue}
                />
              </label>
            </div>
            {editing() ? (
              <section
                class="workboard-field workboard-field--wide"
                aria-labelledby="workboard-card-comments-title"
              >
                <span id="workboard-card-comments-title">
                  {t("workboard.badgeComments", { count: String(comments().length) })}
                </span>
                {comments().length ? (
                  <ol>
                    <For each={[...comments()]} keyed={(comment) => comment.id}>
                      {(comment) => <li>{comment().body}</li>}
                    </For>
                  </ol>
                ) : undefined}
                <textarea
                  class="settings-input workboard-comments__input"
                  aria-labelledby="workboard-card-comments-title"
                  maxlength="2000"
                  disabled={draftActionsBusy()}
                  ref={commentValue}
                />
                <div class="workboard-modal__actions">
                  <button
                    class="btn workboard-comments__submit"
                    type="button"
                    disabled={draftActionsBusy() || !commentBody().trim()}
                    onClick={() => {
                      void addWorkboardCardComment(workboardMutationContext(props));
                    }}
                  >
                    {icons.plus} {t("common.create")}
                  </button>
                </div>
              </section>
            ) : undefined}
          </div>
          <div class="workboard-modal__actions">
            <button
              class="btn"
              type="button"
              disabled={draftDismissalBusy()}
              onClick={dismissDraft}
            >
              {t("common.cancel")}
            </button>
            <button
              class="btn primary workboard-draft__submit"
              disabled={draftActionsBusy() || !draftTitle().trim()}
            >
              {editing() ? t("common.save") : t("common.create")}
            </button>
          </div>
        </form>
        <WorkboardErrorToast
          owner={state()}
          error={visibleError()}
          {...{
            hidden: state().draftDiscardOpen,
          }}
        />
      </>
    </Dialog>
  );
  const keepEditing = () => {
    state().draftDiscardOpen = false;
    props.onRequestUpdate?.();
  };
  const discardTitle = () =>
    editing() ? t("workboard.discardChangesTitle") : t("workboard.discardCardTitle");
  return (
    <>
      {draftDialog}
      {state().draftDiscardOpen ? (
        <CardDiscardDialog
          {...{
            title: discardTitle(),
            onKeepEditing: keepEditing,
            onDiscard: () => {
              if (state().draftSaving) {
                return;
              }
              resetDraftState(state());
              props.onRequestUpdate?.();
            },
            error: <WorkboardErrorToast owner={state()} error={visibleError()} />,
          }}
        />
      ) : undefined}
    </>
  );
}

export function CardDiscardDialog(props: {
  title: string;
  onKeepEditing: () => void;
  onDiscard: () => void;
  error?: import("@solidjs/web").JSX.Element;
}) {
  return (
    <Dialog
      {...{
        label: props.title,
        description: t("workboard.discardDraftHelp"),
        style:
          "--openclaw-modal-width: 400px; --openclaw-modal-backdrop-filter: none; --wa-color-overlay-modal: rgba(0, 0, 0, 0.24);",
        onCancel: () => {
          props.onKeepEditing();
          return true;
        },
      }}
    >
      <>
        <section class="workboard-discard">
          <h2>{props.title}</h2>
          <p>{t("workboard.discardDraftHelp")}</p>
          <div class="workboard-discard__actions">
            <button class="btn" type="button" autofocus onClick={() => props.onKeepEditing()}>
              {t("workboard.keepEditing")}
            </button>
            <button class="btn danger" type="button" onClick={() => props.onDiscard()}>
              {t("workboard.discardDraft")}
            </button>
          </div>
        </section>
        {props.error ?? undefined}
      </>
    </Dialog>
  );
}
