import { html, nothing } from "lit";
import { createRef, ref, type Ref } from "lit/directives/ref.js";
import {
  renderAgentAvatar,
  renderSessionSummary,
  renderDialog,
} from "../../components/host-components.ts";
import { icons } from "../../components/icons.ts";
import { renderWorkboardToast } from "../../components/toast.ts";
import { t } from "../../i18n/index.ts";
import {
  workboardCardBoardId,
  WORKBOARD_ALL_BOARDS_FILTER,
} from "../../lib/workboard/board-filter.ts";
import { workboardBoardName } from "../../lib/workboard/board-presentation.ts";
import {
  addWorkboardCardComment,
  getWorkboardDependencyState,
  getWorkboardLifecycle,
  getWorkboardState,
  type WorkboardCard,
  type WorkboardUiState,
} from "../../lib/workboard/index.ts";
import { cardAgentLabel } from "./agent-filter.ts";
import { automationDetailFields, renderBoardAutomation } from "./view-automation.ts";
import {
  getCardActionState,
  renderArchiveCardAction,
  renderDeleteCardAction,
  renderEditCardAction,
  renderOpenSessionCardAction,
  renderStartExecutionButton,
  renderStopCardAction,
} from "./view-card-actions.ts";
import {
  renderDependencyDetailList,
  renderDetailRow,
  renderTechnicalDetails,
} from "./view-card-detail-records.ts";
import { renderCardDiscardDialog } from "./view-card-modal.ts";
import {
  formatEventLabel,
  formatLifecycle,
  formatPriorityLabel,
  workboardErrorMessage,
  renderPriorityIcon,
  renderLifecycleIcon,
  formatStatusLabel,
  formatUpdatedTime,
  taskDetail,
  taskMatchesLifecycle,
  type WorkboardProps,
} from "./view-helpers.ts";
import {
  renderInlineAgent,
  renderInlinePriority,
  renderInlineStatus,
  renderInlineText,
  type WorkboardInlineText,
} from "./view-inline-properties.ts";
import { closeWorkboardPopoverOnAction, workboardPopoverRef } from "./view-popover.ts";
import { workboardScrollFadeRef } from "./view-scroll-fade.ts";
import { getSessionStatus, renderSessionStatusBadge } from "./view-session-status.ts";

export const workboardCardDetailDrawerId = "workboard-card-detail-drawer";
const workboardCardDetailTitleId = "workboard-card-detail-title";
const workboardCardDetailDescriptionId = "workboard-card-detail-description";

const detailDrawerRefs = new WeakMap<WorkboardUiState, Ref<HTMLElement>>();
const inlineDiscardOpen = new WeakMap<WorkboardUiState, () => void>();

export function openCardDetails(state: WorkboardUiState, card: WorkboardCard) {
  inlineDiscardOpen.delete(state);
  state.detailCardId = card.id;
  state.detailTab = "overview";
  state.detailCommentBody = state.detailCommentDrafts.get(card.id) ?? "";
}

function closeCardDetails(state: WorkboardUiState) {
  inlineDiscardOpen.delete(state);
  state.detailCardId = null;
  state.detailTab = "overview";
  state.detailCommentBody = "";
}

export function getVisibleDetailCard(state: WorkboardUiState): WorkboardCard | null {
  if (!state.detailCardId || state.draftOpen) {
    return null;
  }
  const card = state.cards.find((entry) => entry.id === state.detailCardId) ?? null;
  if (card?.metadata?.archivedAt && !state.showArchived) {
    const editors = detailDrawerRefs
      .get(state)
      ?.value?.querySelectorAll<WorkboardInlineText>("workboard-inline-text");
    const hasDraft = [...(editors ?? [])].some(
      (editor) =>
        editor.props.card.id === card.id && (editor.hasUnsavedChanges || editor.pendingSave),
    );
    if (!hasDraft) {
      return null;
    }
  }
  return card;
}

export function renderCardDetailsPanel(props: WorkboardProps) {
  const state = getWorkboardState(props.host);
  const visibleError = workboardErrorMessage(state, props.pageError);
  const card = getVisibleDetailCard(state);
  if (!card) {
    inlineDiscardOpen.delete(state);
    return nothing;
  }
  const drawer = detailDrawerRefs.get(state) ?? createRef<HTMLElement>();
  detailDrawerRefs.set(state, drawer);
  const inlineEditors = () => [
    ...(drawer.value?.querySelectorAll<WorkboardInlineText>("workboard-inline-text") ?? []),
  ];
  const requestTransition = (transition: () => void) => {
    const editors = inlineEditors();
    if (editors.some((editor) => editor.pendingSave)) {
      return false;
    }
    if (editors.some((editor) => editor.hasUnsavedChanges)) {
      inlineDiscardOpen.set(state, transition);
      props.onRequestUpdate?.();
      return false;
    }
    transition();
    return true;
  };
  const dismissDetails = () =>
    requestTransition(() => {
      closeCardDetails(state);
      props.onRequestUpdate?.();
    });
  const navigateAutomation = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const link = event.currentTarget;
    if (!(link instanceof HTMLAnchorElement) || (link.target && link.target !== "_self")) {
      return;
    }
    let requesting = true;
    const proceed = requestTransition(() => {
      // Clean clicks retain native navigation. Replay a deferred click only after discard.
      if (!requesting && link.isConnected) {
        link.click();
      }
    });
    requesting = false;
    if (!proceed) {
      event.preventDefault();
    }
  };
  const actionProps = {
    ...props,
    onOpenSession: (session: Parameters<WorkboardProps["onOpenSession"]>[0]) => {
      requestTransition(() => props.onOpenSession(session));
    },
  };
  const {
    task,
    busy,
    activeTask,
    live,
    linkedSessionKey,
    sessionTarget,
    writable,
    showStartControls,
    archived,
  } = getCardActionState(props, card);
  const selectTab = (tab: WorkboardUiState["detailTab"], target: EventTarget | null) => {
    if (tab !== state.detailTab && target instanceof HTMLElement) {
      const body = target
        .closest(".workboard-detail")
        ?.querySelector<HTMLElement>(".workboard-detail__body");
      if (body) {
        body.scrollTop = 0;
      }
    }
    state.detailTab = tab;
    props.onRequestUpdate?.();
  };
  const lifecycle = getWorkboardLifecycle(card, props.sessions, task, props.sessionResolution);
  const formatted = formatLifecycle(lifecycle, task);
  const sessionStatus = getSessionStatus(card, lifecycle, task);
  const taskIsAuthoritative = task ? taskMatchesLifecycle(task, lifecycle) : false;
  const comments = card.metadata?.comments ?? [];
  const automation = card.metadata?.automation;
  const boardId = workboardCardBoardId(card);
  const board = state.boards.find((entry) => entry.id === boardId);
  const events = (card.events ?? []).toReversed();
  const dependencies = getWorkboardDependencyState(card, state.cards);
  const technicalDetails = renderTechnicalDetails(
    card,
    task,
    linkedSessionKey,
    state.detailTab === "details",
  );
  const hasTechnicalDetails = technicalDetails !== nothing;
  const tabs = [
    { id: "overview", label: t("workboard.detailTabOverview") },
    { id: "activity", label: t("workboard.detailTabActivity") },
    ...(sessionTarget ? [{ id: "session", label: t("workboard.detailTabSession") } as const] : []),
    ...(hasTechnicalDetails
      ? [{ id: "details", label: t("workboard.detailTabDetails") } as const]
      : []),
  ] as const;
  const activeTab = tabs.some((tab) => tab.id === state.detailTab) ? state.detailTab : "overview";
  const sessionStateLabel =
    task && taskIsAuthoritative ? t(`workboard.taskStatus.${task.status}`) : formatted.label;
  const sessionEmpty = lifecycle.state === "unlinked" && !task && !linkedSessionKey;
  const renderSessionHeading = (tab: "overview" | "session") => html`<div
    class="workboard-detail__execution-main"
  >
    <div
      class="workboard-detail__session-row"
      title=${task && taskIsAuthoritative ? taskDetail(task) : formatted.detail}
    >
      ${
        sessionEmpty || !sessionStatus.visible
          ? html`<span
              class="workboard-detail__session-state-icon"
              role="img"
              aria-label=${sessionStateLabel}
              title=${sessionStateLabel}
            >
              ${sessionEmpty ? icons.bot : renderLifecycleIcon(lifecycle, task)}
            </span>`
          : nothing
      }
      <div class="workboard-detail__session-copy">
        <span
          class="workboard-detail__session-name"
          id=${tab === "overview" ? workboardCardDetailDescriptionId : nothing}
        >
          ${
            sessionEmpty
              ? t("workboard.detailNoSessionYet")
              : (lifecycle.session?.displayName ??
                lifecycle.session?.label ??
                task?.title ??
                (linkedSessionKey ? t("workboard.fieldSession") : formatted.label))
          }
        </span>
        ${
          !sessionEmpty && sessionStatus.detail
            ? html`<p
                class="workboard-detail__session-description"
                .textContent=${sessionStatus.detail}
              ></p>`
            : nothing
        }
        ${
          sessionEmpty && showStartControls && !archived
            ? html`<p class="workboard-detail__session-help">
                ${t("workboard.detailStartSessionHelp", {
                  agent: cardAgentLabel(card, props.agentsList),
                })}
              </p>`
            : nothing
        }
      </div>
      ${renderSessionStatusBadge(sessionStatus)}
    </div>
    <div class="workboard-detail__actions">
      ${
        tab === "overview" && showStartControls
          ? renderStartExecutionButton(actionProps, card, null, "autonomous")
          : nothing
      }
      ${
        tab === "overview" && writable && (linkedSessionKey ? live : activeTask)
          ? renderStopCardAction(props, card, busy)
          : nothing
      }
      ${renderOpenSessionCardAction(actionProps, sessionTarget, { quiet: true })}
    </div>
  </div>`;
  const visibleAutomationFields = automationDetailFields(automation);
  const detailsDialog = renderDialog(
    {
      className: "drawer drawer--floating",
      label: card.title,
      description:
        task && taskIsAuthoritative
          ? taskDetail(task)
          : (lifecycle.session?.displayName ?? formatted.detail),
      style:
        "--openclaw-modal-width: 620px; --openclaw-modal-backdrop-filter: none; --wa-color-overlay-modal: rgba(0, 0, 0, 0.24);",
      onCancel: dismissDetails,
    },
    html`
      <aside id=${workboardCardDetailDrawerId} class="workboard-detail-drawer" ${ref(drawer)}>
        <div class="workboard-detail">
          <header class="workboard-detail__header">
            <h2 id=${workboardCardDetailTitleId}>
              <span class="sr-only">${t("workboard.detailTitle")}: </span>${renderInlineText(
                props,
                card,
                "title",
                busy,
                !writable || archived,
              )}
            </h2>
            <div class="workboard-detail__header-actions">
              ${
                writable
                  ? html`
                      <button
                        class="btn btn--icon workboard-detail__icon"
                        type="button"
                        popovertarget="workboard-detail-actions"
                        aria-label=${t("workboard.cardActions")}
                        aria-haspopup="true"
                        aria-expanded="false"
                      >
                        ${icons.moreHorizontal}
                      </button>
                      <div
                        id="workboard-detail-actions"
                        class="workboard-detail__menu"
                        popover="auto"
                        role="group"
                        aria-label=${t("workboard.cardActions")}
                        ${ref(workboardPopoverRef("end"))}
                        @click=${closeWorkboardPopoverOnAction}
                      >
                        ${!archived ? renderEditCardAction(props, card, { requestAction: requestTransition }) : nothing}
                        ${renderArchiveCardAction(props, card, busy, archived, { requestAction: requestTransition })}
                        ${renderDeleteCardAction(props, card, busy, { requestAction: requestTransition })}
                      </div>
                    `
                  : nothing
              }
              <button
                class="btn btn--icon workboard-detail__icon workboard-detail__close"
                type="button"
                aria-label=${t("common.close")}
                @click=${dismissDetails}
              >
                ${icons.x}
              </button>
            </div>
          </header>
          <div
            class="workboard-detail__tabs"
            role="tablist"
            aria-label=${t("workboard.detailTitle")}
            @keydown=${(event: KeyboardEvent) => {
              const index = tabs.findIndex((tab) => tab.id === activeTab);
              let next: number;
              if (event.key === "ArrowRight") {
                next = (index + 1) % tabs.length;
              } else if (event.key === "ArrowLeft") {
                next = (index + tabs.length - 1) % tabs.length;
              } else if (event.key === "Home") {
                next = 0;
              } else if (event.key === "End") {
                next = tabs.length - 1;
              } else {
                return;
              }
              const nextTab = tabs[next];
              if (!nextTab) {
                return;
              }
              event.preventDefault();
              selectTab(nextTab.id, event.currentTarget);
              if (event.currentTarget instanceof HTMLElement) {
                const buttons =
                  event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]");
                buttons[next]?.focus();
              }
            }}
          >
            ${tabs.map(
              (tab) => html`<button
                type="button"
                role="tab"
                id=${`workboard-detail-tab-${tab.id}`}
                aria-controls=${`workboard-detail-panel-${tab.id}`}
                aria-selected=${String(activeTab === tab.id)}
                tabindex=${activeTab === tab.id ? "0" : "-1"}
                ?autofocus=${activeTab === tab.id}
                @click=${(event: MouseEvent) => selectTab(tab.id, event.currentTarget)}
              >
                ${tab.label}
              </button>`,
            )}
          </div>
          <div class="workboard-detail__body" ${ref(workboardScrollFadeRef())}>
            <section
              class="workboard-detail__tabpanel"
              id="workboard-detail-panel-overview"
              role="tabpanel"
              aria-labelledby="workboard-detail-tab-overview"
              tabindex="0"
              ?hidden=${activeTab !== "overview"}
            >
              <div class="workboard-detail__layout">
                <aside
                  class="workboard-detail__properties"
                  aria-label=${t("workboard.detailProperties")}
                >
                  <div class="workboard-detail__row">
                    <span>${t("workboard.fieldStatus")}</span>
                    ${
                      writable && !archived && state.statuses.length > 1
                        ? renderInlineStatus(props, card, busy)
                        : html`<strong>${formatStatusLabel(card.status)}</strong>`
                    }
                  </div>
                  <div class="workboard-detail__row">
                    <span>${t("workboard.fieldPriority")}</span>
                    ${
                      writable && !archived
                        ? renderInlinePriority(props, card, busy)
                        : html`<strong
                            class="workboard-detail__priority workboard-detail__priority--${card.priority}"
                          >
                            ${renderPriorityIcon(card.priority)}${formatPriorityLabel(card.priority)}
                          </strong>`
                    }
                  </div>
                  <div class="workboard-detail__row">
                    <span>${t("workboard.fieldAgent")}</span>
                    ${
                      writable && !archived
                        ? renderInlineAgent(props, card, busy)
                        : html`<strong class="workboard-detail__agent">
                            ${renderAgentAvatar({
                              agentId:
                                card.agentId?.trim() ||
                                props.agentsList?.defaultId ||
                                props.defaultAgentId ||
                                "",
                              label: cardAgentLabel(card, props.agentsList),
                            })}
                            <span>${cardAgentLabel(card, props.agentsList)}</span>
                          </strong>`
                    }
                  </div>
                  ${renderDetailRow(
                    t("workboard.detailUpdated"),
                    formatUpdatedTime(card.updatedAt),
                  )}
                  ${
                    state.boardFilter === WORKBOARD_ALL_BOARDS_FILTER
                      ? renderDetailRow(
                          t("workboard.detailBoard"),
                          workboardBoardName(board ?? { id: boardId }),
                        )
                      : nothing
                  }
                  <div class="workboard-detail__label-group">
                    <span>${t("workboard.fieldLabels")}</span>
                    ${renderInlineText(props, card, "labels", busy, !writable || archived)}
                  </div>
                </aside>
                <div class="workboard-detail__content">
                  ${renderInlineText(props, card, "notes", busy, !writable || archived)}
                  <section
                    class="workboard-detail__execution ${
                      sessionEmpty ? "workboard-detail__execution--empty" : ""
                    }"
                    aria-label=${t("workboard.fieldSession")}
                  >
                    ${renderSessionHeading("overview")}
                    ${
                      showStartControls
                        ? html`
                            <details
                              class="workboard-detail__disclosure workboard-detail__engine-options"
                            >
                              <summary>
                                <span
                                  class="workboard-detail__disclosure-chevron"
                                  aria-hidden="true"
                                  >${icons.chevronDown}</span
                                >
                                ${t("workboard.detailExecutionOptions")}
                              </summary>
                              <div class="workboard-detail__engine-groups">
                                ${
                                  props.canModelOverride !== false
                                    ? html`
                                        <div class="workboard-detail__engine-group">
                                          <span>${t("workboard.detailRunAutomatically")}</span>
                                          <div class="workboard-detail__actions">
                                            ${renderStartExecutionButton(
                                              actionProps,
                                              card,
                                              "codex",
                                              "autonomous",
                                              { engineLabelOnly: true },
                                            )}
                                            ${renderStartExecutionButton(
                                              actionProps,
                                              card,
                                              "claude",
                                              "autonomous",
                                              { engineLabelOnly: true },
                                            )}
                                          </div>
                                        </div>
                                      `
                                    : nothing
                                }
                                <div class="workboard-detail__engine-group">
                                  <span>${t("workboard.detailOpenManually")}</span>
                                  <div class="workboard-detail__actions">
                                    ${renderStartExecutionButton(
                                      actionProps,
                                      card,
                                      "codex",
                                      "manual",
                                      {
                                        engineLabelOnly: true,
                                      },
                                    )}
                                    ${renderStartExecutionButton(
                                      actionProps,
                                      card,
                                      "claude",
                                      "manual",
                                      {
                                        engineLabelOnly: true,
                                      },
                                    )}
                                  </div>
                                </div>
                              </div>
                            </details>
                          `
                        : nothing
                    }
                  </section>
                  ${renderBoardAutomation(props.detailBoardAutomation, navigateAutomation)}
                  ${
                    automation?.summary || visibleAutomationFields.length
                      ? html`<section
                          class="workboard-detail__section workboard-detail__automation"
                        >
                          <h3>${t("workboard.detailCardAutomation")}</h3>
                          ${automation?.summary ? html`<p>${automation.summary}</p>` : nothing}
                          ${visibleAutomationFields.map(([label, value]) =>
                            renderDetailRow(label, value),
                          )}
                        </section>`
                      : nothing
                  }
                  ${renderDependencyDetailList(dependencies)}
                </div>
              </div>
            </section>
            <section
              class="workboard-detail__tabpanel workboard-detail__activity-panel"
              id="workboard-detail-panel-activity"
              role="tabpanel"
              aria-labelledby="workboard-detail-tab-activity"
              tabindex="0"
              ?hidden=${activeTab !== "activity"}
            >
              <section class="workboard-detail__section workboard-detail__activity">
                ${
                  events.length
                    ? html`
                        <h3>${t("workboard.eventsLabel")}</h3>
                        <ol class="workboard-detail__list workboard-detail__events">
                          ${events.map(
                            (event) => html`<li>
                              <span>${formatEventLabel(event)}</span>
                              <time>${formatUpdatedTime(event.at)}</time>
                            </li>`,
                          )}
                        </ol>
                      `
                    : nothing
                }
                ${
                  comments.length
                    ? html`
                        <h3>${t("workboard.detailOperatorNotes")}</h3>
                        <ol class="workboard-detail__list workboard-detail__comments">
                          ${comments.map(
                            (comment) => html`<li>
                              <span>${comment.body}</span>
                              <time>${formatUpdatedTime(comment.createdAt)}</time>
                            </li>`,
                          )}
                        </ol>
                      `
                    : !events.length
                      ? html`<p class="workboard-detail__empty">${t("workboard.detailNoNotes")}</p>`
                      : nothing
                }
                ${
                  writable
                    ? html`
                        <div class="workboard-detail__comment-compose">
                          <textarea
                            class="settings-input workboard-detail__note"
                            aria-label=${t("workboard.detailOperatorNotes")}
                            rows="2"
                            maxlength="2000"
                            placeholder=${t("workboard.detailNotePlaceholder")}
                            .value=${state.detailCommentBody}
                            ?disabled=${busy}
                            @input=${(event: InputEvent) => {
                              if (!(event.currentTarget instanceof HTMLTextAreaElement)) {
                                return;
                              }
                              state.detailCommentBody = event.currentTarget.value;
                              state.detailCommentDrafts.set(card.id, state.detailCommentBody);
                              props.onRequestUpdate?.();
                            }}
                          ></textarea>
                          <button
                            class="btn"
                            type="button"
                            ?disabled=${busy || !state.detailCommentBody.trim()}
                            @click=${() =>
                              addWorkboardCardComment({
                                host: props.host,
                                client: props.client,
                                cardId: card.id,
                                body: state.detailCommentBody,
                                requestUpdate: props.onRequestUpdate,
                              })}
                          >
                            ${t("workboard.detailAddNote")}
                          </button>
                        </div>
                      `
                    : nothing
                }
              </section>
            </section>
            ${technicalDetails}
            ${
              sessionTarget
                ? html`<section
                    class="workboard-detail__tabpanel workboard-detail__session-panel"
                    id="workboard-detail-panel-session"
                    role="tabpanel"
                    aria-labelledby="workboard-detail-tab-session"
                    tabindex="0"
                    ?hidden=${activeTab !== "session"}
                  >
                    ${renderSessionHeading("session")}
                    ${
                      activeTab === "session"
                        ? renderSessionSummary({
                            session: sessionTarget,
                            presented: props.presented !== false,
                          })
                        : nothing
                    }
                  </section>`
                : nothing
            }
          </div>
        </div>
      </aside>
      ${renderWorkboardToast({
        owner: state,
        message: visibleError ?? "",
        key: visibleError,
        tone: "error",
      })}
    `,
  );
  return html`
    ${detailsDialog}
    ${
      inlineDiscardOpen.has(state)
        ? renderCardDiscardDialog({
            title: t("workboard.discardChangesTitle"),
            onKeepEditing: () => {
              inlineDiscardOpen.delete(state);
              props.onRequestUpdate?.();
            },
            onDiscard: () => {
              const transition = inlineDiscardOpen.get(state);
              inlineDiscardOpen.delete(state);
              for (const editor of inlineEditors()) {
                editor.discardDraft();
              }
              transition?.();
              props.onRequestUpdate?.();
            },
          })
        : nothing
    }
  `;
}
