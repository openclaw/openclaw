import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import {
  renderAgentAvatar,
  renderSessionSummary,
  renderDialog,
} from "../../components/host-components.ts";
import { icons } from "../../components/icons.ts";
import { renderWorkboardToast } from "../../components/toast.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
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
  renderDetailList,
  renderAttemptDetails,
  renderProofDetails,
  getDetailSections,
} from "./view-card-detail-records.ts";
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
} from "./view-inline-properties.ts";
import { closeWorkboardPopoverOnAction, workboardPopoverRef } from "./view-popover.ts";
import { workboardScrollFadeRef } from "./view-scroll-fade.ts";
import { getSessionStatus, renderSessionStatusBadge } from "./view-session-status.ts";

export const workboardCardDetailDrawerId = "workboard-card-detail-drawer";
const workboardCardDetailTitleId = "workboard-card-detail-title";
const workboardCardDetailDescriptionId = "workboard-card-detail-description";

export function openCardDetails(state: WorkboardUiState, card: WorkboardCard) {
  state.detailCardId = card.id;
  state.detailTab = "overview";
  state.detailCommentBody = state.detailCommentDrafts.get(card.id) ?? "";
}

function closeCardDetails(state: WorkboardUiState) {
  state.detailCardId = null;
  state.detailTab = "overview";
  state.detailCommentBody = "";
}

export function getVisibleDetailCard(state: WorkboardUiState): WorkboardCard | null {
  if (!state.detailCardId || state.draftOpen) {
    return null;
  }
  const card = state.cards.find((entry) => entry.id === state.detailCardId) ?? null;
  if (!card || (card.metadata?.archivedAt && !state.showArchived)) {
    return null;
  }
  return card;
}

export function renderCardDetailsPanel(props: WorkboardProps) {
  const state = getWorkboardState(props.host);
  const visibleError = workboardErrorMessage(state, props.pageError);
  const card = getVisibleDetailCard(state);
  if (!card) {
    return nothing;
  }
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
  const attempts = card.metadata?.attempts ?? [];
  const proof = card.metadata?.proof ?? [];
  const automation = card.metadata?.automation;
  const metadata = card.metadata;
  const notifications = metadata?.notifications ?? [];
  const metadataFields: Array<readonly [string, string | number | undefined]> = [
    [
      t("workboard.detailTemplate"),
      metadata?.templateId ? t(`workboard.template.${metadata.templateId}`) : undefined,
    ],
    [t("workboard.detailFailures"), metadata?.failureCount],
    [
      t("workboard.fieldStatus"),
      metadata?.stale
        ? `${t("workboard.badgeStale")}: ${formatUiExternalText(metadata.stale.reason)}`
        : undefined,
    ],
    [
      t("workboard.detailClaim"),
      metadata?.claim ? formatUiExternalText(metadata.claim.ownerId) : undefined,
    ],
    [
      t("workboard.detailHeartbeat"),
      metadata?.claim ? formatUpdatedTime(metadata.claim.lastHeartbeatAt) : undefined,
    ],
  ];
  const boardId = workboardCardBoardId(card);
  const board = state.boards.find((entry) => entry.id === boardId);
  const events = (card.events ?? []).toReversed();
  const dependencies = getWorkboardDependencyState(card, state.cards);
  const detailSections = getDetailSections(card);
  const hasTechnicalDetails = Boolean(
    task?.taskId ||
    card.taskId ||
    linkedSessionKey ||
    card.runId ||
    card.execution?.runId ||
    automation?.tenant ||
    metadataFields.some(([, value]) => value !== undefined && value !== "") ||
    notifications.length ||
    attempts.length ||
    proof.length ||
    detailSections.some(([, values]) => values.some((value) => value.trim())),
  );
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
          ? renderStartExecutionButton(props, card, null, "autonomous")
          : nothing
      }
      ${
        tab === "overview" && writable && (linkedSessionKey ? live : activeTask)
          ? renderStopCardAction(props, card, busy)
          : nothing
      }
      ${renderOpenSessionCardAction(props, sessionTarget, { quiet: true })}
    </div>
  </div>`;
  const visibleAutomationFields = automationDetailFields(automation);
  return renderDialog(
    {
      className: "drawer drawer--floating",
      label: card.title,
      description:
        task && taskIsAuthoritative
          ? taskDetail(task)
          : (lifecycle.session?.displayName ?? formatted.detail),
      style:
        "--openclaw-modal-width: 620px; --openclaw-modal-backdrop-filter: none; --wa-color-overlay-modal: rgba(0, 0, 0, 0.24);",
      onCancel: () => {
        closeCardDetails(state);
        props.onRequestUpdate?.();
      },
    },
    html`
      <aside id=${workboardCardDetailDrawerId} class="workboard-detail-drawer">
        <div class="workboard-detail">
          <header class="workboard-detail__header">
            <h2 id=${workboardCardDetailTitleId}>
              <span class="sr-only">${t("workboard.detailTitle")}: </span>${
                writable && !archived ? renderInlineText(props, card, "title", busy) : card.title
              }
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
                        ${!archived ? renderEditCardAction(props, card) : nothing}
                        ${renderArchiveCardAction(props, card, busy, archived)}
                        ${renderDeleteCardAction(props, card, busy)}
                      </div>
                    `
                  : nothing
              }
              <button
                class="btn btn--icon workboard-detail__icon workboard-detail__close"
                type="button"
                aria-label=${t("common.close")}
                @click=${() => {
                  closeCardDetails(state);
                  props.onRequestUpdate?.();
                }}
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
                  ${
                    (writable && !archived) || card.labels.length
                      ? html` <div class="workboard-detail__label-group">
                          <span>${t("workboard.fieldLabels")}</span>
                          ${
                            writable && !archived
                              ? renderInlineText(props, card, "labels", busy)
                              : html`<div class="workboard-detail__labels">
                                  ${card.labels.map((label) => html`<span>${label}</span>`)}
                                </div>`
                          }
                        </div>`
                      : nothing
                  }
                </aside>
                <div class="workboard-detail__content">
                  ${
                    writable && !archived
                      ? renderInlineText(props, card, "notes", busy)
                      : card.notes
                        ? html`<p class="workboard-detail__description">${card.notes}</p>`
                        : nothing
                  }
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
                                              props,
                                              card,
                                              "codex",
                                              "autonomous",
                                              { engineLabelOnly: true },
                                            )}
                                            ${renderStartExecutionButton(
                                              props,
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
                                    ${renderStartExecutionButton(props, card, "codex", "manual", {
                                      engineLabelOnly: true,
                                    })}
                                    ${renderStartExecutionButton(props, card, "claude", "manual", {
                                      engineLabelOnly: true,
                                    })}
                                  </div>
                                </div>
                              </div>
                            </details>
                          `
                        : nothing
                    }
                  </section>
                  ${renderBoardAutomation(props.detailBoardAutomation)}
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
            ${
              hasTechnicalDetails
                ? html`<section
                    class="workboard-detail__tabpanel workboard-detail__technical"
                    id="workboard-detail-panel-details"
                    role="tabpanel"
                    aria-labelledby="workboard-detail-tab-details"
                    tabindex="0"
                    ?hidden=${activeTab !== "details"}
                  >
                    <h3>${t("workboard.detailTechnical")}</h3>
                    <div class="workboard-detail__technical-properties">
                      ${renderDetailRow(t("workboard.detailTask"), task?.taskId ?? card.taskId)}
                      ${renderDetailRow(t("workboard.fieldSession"), linkedSessionKey)}
                      ${renderDetailRow(
                        t("workboard.detailRun"),
                        card.runId ?? card.execution?.runId,
                      )}
                      ${renderDetailRow(t("workboard.detailTenant"), automation?.tenant)}
                      ${metadataFields.map(([label, value]) => renderDetailRow(label, value))}
                    </div>
                    ${
                      task
                        ? renderDetailList(t("workboard.detailTask"), [
                            t(`workboard.taskStatus.${task.status}`),
                            formatUiExternalText(task.progressSummary),
                            formatUiExternalText(task.terminalSummary),
                            formatUiExternalText(task.error),
                          ])
                        : nothing
                    }
                    ${
                      notifications.length
                        ? html`<section class="workboard-detail__section">
                            <h3>${t("workboard.detailNotifications")}</h3>
                            <ol class="workboard-detail__list">
                              ${notifications.map(
                                (notification) =>
                                  html`<li>${formatUiExternalText(notification.message)}</li>`,
                              )}
                            </ol>
                          </section>`
                        : nothing
                    }
                    ${renderAttemptDetails(attempts)} ${renderProofDetails(proof)}
                    ${detailSections.map(([title, values]) => renderDetailList(title, values))}
                  </section>`
                : nothing
            }
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
                        ? renderSessionSummary({ session: sessionTarget, presented: true })
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
}
