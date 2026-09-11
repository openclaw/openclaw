import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import {
  renderAgentPicker,
  renderDialog,
  renderSelectPicker,
} from "../../components/host-components.ts";
import { icons } from "../../components/icons.ts";
import { renderWorkboardToast } from "../../components/toast.ts";
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
  renderPriorityIcon,
  formatStatusLabel,
  isWorkboardSessionChoice,
  type WorkboardProps,
} from "./view-helpers.ts";
import type { WorkboardSelectOption } from "./workboard-select.ts";

const workboardCardModalTitleId = "workboard-card-modal-title";
const workboardCardModalDescriptionId = "workboard-card-modal-description";
export const workboardCardModalId = "workboard-card-modal";
const initialDrafts = new WeakMap<WorkboardUiState, string>();

function draftFingerprint(state: WorkboardUiState): string {
  const payload = draftPayload(state);
  return JSON.stringify({ ...payload, title: payload.title.trim(), notes: payload.notes.trim() });
}

// Keep keystroke state local to the form. A parent render can restore stale
// controlled values before the next field is edited or the draft is submitted.
function syncDraftTextInput(
  state: WorkboardUiState,
  form: HTMLFormElement,
  input: HTMLInputElement | HTMLTextAreaElement,
  draftActionsBusy: boolean,
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
    return;
  }

  const draftSubmit = form.querySelector<HTMLButtonElement>(".workboard-draft__submit");
  if (draftSubmit) {
    draftSubmit.disabled = draftActionsBusy || !state.draftTitle.trim();
  }
  const commentSubmit = form.querySelector<HTMLButtonElement>(".workboard-comments__submit");
  if (commentSubmit) {
    commentSubmit.disabled = draftActionsBusy || !state.draftCommentBody.trim();
  }
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

function renderDraftChoices<Value extends string>(params: {
  name: "status" | "priority";
  label: string;
  value: Value;
  options: readonly WorkboardSelectOption<Value>[];
  renderIcon?: (value: Value) => unknown;
  disabled: boolean;
  onChange: (value: Value) => void;
}) {
  return html`
    <fieldset
      class="workboard-choice-field ${params.name === "status" ? "workboard-field--wide" : ""}"
      ?disabled=${params.disabled}
    >
      <legend>${params.label}</legend>
      <div class="workboard-segments workboard-segments--${params.name}">
        ${params.options.map(
          (option) => html`
            <label
              class="workboard-segment ${
                params.name === "status" ? `workboard-segment--${option.value}` : ""
              }"
            >
              <input
                type="radio"
                name=${params.name}
                value=${option.value}
                .checked=${params.value === option.value}
                @change=${() => params.onChange(option.value)}
              />
              <span
                >${
                  params.renderIcon
                    ? html`<i aria-hidden="true">${params.renderIcon(option.value)}</i>`
                    : nothing
                }${option.label}</span
              >
            </label>
          `,
        )}
      </div>
    </fieldset>
  `;
}

export function renderCardModal(props: WorkboardProps) {
  const state = getWorkboardState(props.host);
  const visibleError = workboardErrorMessage(state, props.pageError);
  const sessions = props.sessions.filter(isWorkboardSessionChoice);
  const statusOptions: WorkboardSelectOption<WorkboardStatus>[] = state.statuses.map((status) => ({
    value: status,
    label: formatStatusLabel(status),
  }));
  const priorityOptions: WorkboardSelectOption<WorkboardPriority>[] = WORKBOARD_PRIORITIES.map(
    (priority) => ({ value: priority, label: formatPriorityLabel(priority) }),
  );
  const defaultAgentId = props.agentsList?.defaultId ?? props.defaultAgentId ?? "";
  const assignableAgentOptions = buildAssignableAgentPickerOptions(
    props.agentsList,
    state.draftAgentId,
    defaultAgentId,
  );
  const sessionOptions = [
    { value: "", label: t("workboard.noLinkedSession") },
    ...sessions.map((session) => ({
      value: session.key,
      label: session.displayName ?? session.label ?? session.key,
      description: session.displayName || session.label ? session.key : undefined,
    })),
  ];
  if (
    state.draftSessionKey &&
    !sessionOptions.some((option) => option.value === state.draftSessionKey)
  ) {
    sessionOptions.push({ value: state.draftSessionKey, label: state.draftSessionKey });
  }
  if (!state.draftOpen) {
    return nothing;
  }
  const editing = Boolean(state.editingCardId);
  const editingCard = state.editingCardId
    ? (state.cards.find((card) => card.id === state.editingCardId) ?? null)
    : null;
  const comments = editingCard?.metadata?.comments ?? [];
  const draftCommentBusy = editing && state.busyCardIds.has(state.editingCardId ?? "");
  const draftActionsBusy =
    !canMutate(props) ||
    state.loading ||
    state.dispatching ||
    state.draftSaving ||
    draftCommentBusy;
  // Save completion resets this shared draft. Lock every edit and dismissal path
  // only for that write so stale drafts can still use Cancel to recover readiness.
  const draftDismissalBusy = state.draftSaving;
  const dismissDraft = () => {
    if (draftDismissalBusy) {
      return false;
    }
    const changed =
      state.draftCommentBody.trim() ||
      (editing
        ? Object.keys(changedDraftPayload(state)).length > 0
        : draftFingerprint(state) !== initialDrafts.get(state));
    if (changed) {
      state.draftDiscardOpen = true;
      props.onRequestUpdate?.();
      return false;
    }
    resetDraftState(state);
    return true;
  };
  const draftDialog = renderDialog(
    {
      label: editing ? t("workboard.editCard") : t("workboard.newCard"),
      description: editing ? t("workboard.editCardHelp") : t("workboard.newCardHelp"),
      style:
        "--openclaw-modal-width: 700px; --openclaw-modal-max-height: calc(100dvh - 40px); --openclaw-modal-backdrop-filter: blur(1px); --wa-color-overlay-modal: rgba(0, 0, 0, 0.32);",
      onCancel: () => {
        if (!dismissDraft()) {
          return false;
        }
        props.onRequestUpdate?.();
        return true;
      },
    },
    html`
      <form
        id=${workboardCardModalId}
        class="workboard-draft workboard-card-draft"
        aria-busy=${draftActionsBusy ? "true" : "false"}
        @input=${(event: InputEvent) => {
          const input = event.target;
          if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
            syncDraftTextInput(
              state,
              event.currentTarget as HTMLFormElement,
              input,
              draftActionsBusy,
            );
          }
        }}
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          if (draftActionsBusy) {
            return;
          }
          void saveWorkboardCardDraft({
            host: props.host,
            client: props.client,
            requestUpdate: props.onRequestUpdate,
          });
        }}
      >
        <div class="workboard-modal__header">
          <div>
            <h2 id=${workboardCardModalTitleId}>
              ${editing ? t("workboard.editCard") : t("workboard.newCard")}
            </h2>
            <p id=${workboardCardModalDescriptionId} class="workboard-draft__accessible-label">
              ${editing ? t("workboard.editCardHelp") : t("workboard.newCardHelp")}
            </p>
          </div>
          <span title=${t("common.cancel")}>
            <button
              class="btn btn--icon workboard-modal__close"
              type="button"
              aria-label=${t("common.cancel")}
              ?disabled=${draftDismissalBusy}
              @click=${() => {
                if (dismissDraft()) {
                  props.onRequestUpdate?.();
                }
              }}
            >
              ${icons.x}
            </button>
          </span>
        </div>
        <div class="workboard-draft__body">
          <div class="workboard-draft__main">
            <label class="workboard-field">
              <span class="workboard-draft__accessible-label">${t("workboard.fieldTitle")}</span>
              <input
                class="settings-input workboard-draft__title"
                autofocus
                placeholder=${t("workboard.titlePlaceholder")}
                ?disabled=${draftActionsBusy}
                .value=${live(state.draftTitle)}
              />
            </label>
            ${
              !editing
                ? html`
                    <div
                      class="workboard-template-strip"
                      aria-label=${t("workboard.templatesLabel")}
                    >
                      <span class="workboard-template-strip__label"
                        >${t("workboard.suggestionsLabel")}</span
                      >
                      ${workboardTemplates.map(
                        (template) => html`
                          <button
                            class="workboard-template-strip__suggestion"
                            type="button"
                            ?disabled=${draftActionsBusy}
                            @click=${() => {
                              applyTemplate(state, template.id);
                              props.onRequestUpdate?.();
                            }}
                          >
                            ${icons.plus} ${t(`workboard.template.${template.id}`)}
                          </button>
                        `,
                      )}
                    </div>
                  `
                : nothing
            }
            <label class="workboard-field">
              <span class="workboard-draft__accessible-label">${t("workboard.fieldNotes")}</span>
              <textarea
                class="settings-input workboard-draft__notes"
                rows="3"
                placeholder=${t("workboard.notesPlaceholder")}
                ?disabled=${draftActionsBusy}
                .value=${live(state.draftNotes)}
              ></textarea>
            </label>
          </div>
          <div class="workboard-draft__meta">
            ${renderDraftChoices({
              name: "status",
              value: state.draftStatus,
              options: statusOptions,
              label: t("workboard.fieldStatus"),
              onChange: (value) => {
                state.draftStatus = value;
                props.onRequestUpdate?.();
              },
              disabled: draftActionsBusy,
            })}
            <div class="workboard-field">
              <span>${t("workboard.fieldAgent")}</span>
              ${renderAgentPicker(
                {
                  options: assignableAgentOptions,
                  value: state.draftAgentId,
                  accessibleLabel: t("workboard.fieldAgent"),
                  disabled: draftActionsBusy,
                  onSelect: (value: string) => {
                    state.draftAgentId = value;
                    props.onRequestUpdate?.();
                  },
                },
                "workboard-agent-select",
              )}
            </div>
            <div class="workboard-field">
              <span>${t("workboard.fieldSession")}</span>
              ${renderSelectPicker(
                {
                  value: state.draftSessionKey,
                  options: sessionOptions,
                  accessibleLabel: t("workboard.fieldSession"),
                  searchable: true,
                  onSelect: (value) => {
                    state.draftSessionKey = value;
                    props.onRequestUpdate?.();
                  },
                  disabled: draftActionsBusy,
                },
                "workboard-session-select",
              )}
            </div>
            ${renderDraftChoices({
              name: "priority",
              value: state.draftPriority,
              options: priorityOptions,
              renderIcon: renderPriorityIcon,
              label: t("workboard.fieldPriority"),
              onChange: (value) => {
                state.draftPriority = value;
                props.onRequestUpdate?.();
              },
              disabled: draftActionsBusy,
            })}
            <label class="workboard-field">
              <span>${t("workboard.fieldLabels")}</span>
              <input
                class="settings-input workboard-draft__labels"
                spellcheck="false"
                placeholder=${t("workboard.labelsPlaceholder")}
                ?disabled=${draftActionsBusy}
                .value=${live(state.draftLabels)}
              />
            </label>
          </div>
          ${
            editing
              ? html`
                  <section
                    class="workboard-field workboard-field--wide"
                    aria-labelledby="workboard-card-comments-title"
                  >
                    <span id="workboard-card-comments-title">
                      ${t("workboard.badgeComments", { count: String(comments.length) })}
                    </span>
                    ${
                      comments.length
                        ? html`
                            <ol>
                              ${comments.map((comment) => html`<li>${comment.body}</li>`)}
                            </ol>
                          `
                        : nothing
                    }
                    <textarea
                      class="settings-input workboard-comments__input"
                      aria-labelledby="workboard-card-comments-title"
                      maxlength="2000"
                      ?disabled=${draftActionsBusy}
                      .value=${state.draftCommentBody}
                    ></textarea>
                    <div class="workboard-modal__actions">
                      <button
                        class="btn workboard-comments__submit"
                        type="button"
                        ?disabled=${draftActionsBusy || !state.draftCommentBody.trim()}
                        @click=${() => {
                          void addWorkboardCardComment({
                            host: props.host,
                            client: props.client,
                            requestUpdate: props.onRequestUpdate,
                          });
                        }}
                      >
                        ${icons.plus} ${t("common.create")}
                      </button>
                    </div>
                  </section>
                `
              : nothing
          }
        </div>
        <div class="workboard-modal__actions">
          <button
            class="btn"
            type="button"
            ?disabled=${draftDismissalBusy}
            @click=${() => {
              if (dismissDraft()) {
                props.onRequestUpdate?.();
              }
            }}
          >
            ${t("common.cancel")}
          </button>
          <button
            class="btn primary workboard-draft__submit"
            ?disabled=${draftActionsBusy || !state.draftTitle.trim()}
          >
            ${editing ? t("common.save") : t("common.create")}
          </button>
        </div>
      </form>
      ${renderWorkboardToast({
        owner: state,
        message: visibleError ?? "",
        key: visibleError,
        tone: "error",
        hidden: state.draftDiscardOpen,
      })}
    `,
  );
  const keepEditing = () => {
    state.draftDiscardOpen = false;
    props.onRequestUpdate?.();
  };
  const discardTitle = editing
    ? t("workboard.discardChangesTitle")
    : t("workboard.discardCardTitle");
  return html`
    ${draftDialog}
    ${
      state.draftDiscardOpen
        ? renderDialog(
            {
              label: discardTitle,
              description: t("workboard.discardDraftHelp"),
              style:
                "--openclaw-modal-width: 400px; --openclaw-modal-backdrop-filter: none; --wa-color-overlay-modal: rgba(0, 0, 0, 0.24);",
              onCancel: () => {
                keepEditing();
                return true;
              },
            },
            html`
              <section class="workboard-discard">
                <h2>${discardTitle}</h2>
                <p>${t("workboard.discardDraftHelp")}</p>
                <div class="workboard-discard__actions">
                  <button class="btn" type="button" autofocus @click=${keepEditing}>
                    ${t("workboard.keepEditing")}
                  </button>
                  <button
                    class="btn danger"
                    type="button"
                    @click=${() => {
                      if (state.draftSaving) {
                        return;
                      }
                      resetDraftState(state);
                      props.onRequestUpdate?.();
                    }}
                  >
                    ${t("workboard.discardDraft")}
                  </button>
                </div>
              </section>
              ${renderWorkboardToast({
                owner: state,
                message: visibleError ?? "",
                key: visibleError,
                tone: "error",
              })}
            `,
          )
        : nothing
    }
  `;
}
