import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { renderAgentAvatar } from "../../components/host-components.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatDurationCompact } from "../../lib/format.ts";
import { selectCardAlert, type CardAlert } from "../../lib/workboard/card-alerts.ts";
import type {
  WorkboardCard,
  WorkboardLifecycle,
  WorkboardTaskSummary,
} from "../../lib/workboard/index.ts";
import { cardAgentLabel } from "./agent-filter.ts";
import { cardRelativeTime } from "./view-card-time.ts";
import {
  formatPriorityLabel,
  formatUpdatedTime,
  renderLifecycleIcon,
  renderPriorityIcon,
  type WorkboardProps,
} from "./view-helpers.ts";
import { renderSessionStatus, type SessionStatusPresentation } from "./view-session-status.ts";

function alertLabel(alert: CardAlert) {
  if (alert.kind === "stale") {
    if (alert.ageMs === undefined) {
      return t("workboard.sessionStatus.stale");
    }
    const minutes = Math.max(1, Math.floor((alert.ageMs ?? 0) / 60_000));
    return t("workboard.cardStaleAge", { age: formatDurationCompact(minutes * 60_000) ?? "" });
  }
  if (alert.kind === "dependency") {
    return t("workboard.dependenciesBlocked", { count: String(alert.count) });
  }
  return formatUiExternalText(alert.title);
}

export function renderCardAlert(alerts: CardAlert[], descriptionId: string) {
  const alert = selectCardAlert(alerts);
  if (!alert) {
    return nothing;
  }
  const fullText = alerts
    .map((entry) =>
      [
        ...new Set(
          [
            alertLabel(entry),
            formatUiExternalText(entry.title),
            formatUiExternalText(entry.detail),
          ].filter(Boolean),
        ),
      ].join(" — "),
    )
    .join("\n");
  return html`<div
      class="workboard-card__alert workboard-card__alert--${alert.severity}"
      title=${fullText}
    >
      <span class="workboard-truncate">${alertLabel(alert)}</span>
      <span class="workboard-card__alert-marker" aria-hidden="true"
        >${alert.severity === "info" ? icons.info : icons.alertTriangle}</span
      >
    </div>
    <span id=${descriptionId} hidden>${fullText}</span>`;
}

export function renderCardUpdatedTime(updatedAt: number | undefined, now: number) {
  return updatedAt === undefined
    ? nothing
    : html`<time
        class="workboard-card__updated"
        datetime=${new Date(updatedAt).toISOString()}
        title=${t("workboard.detailUpdatedValue", { time: formatUpdatedTime(updatedAt) })}
        >${cardRelativeTime(updatedAt, now)}</time
      >`;
}

export function renderCardPriority(card: WorkboardCard) {
  return card.priority === "normal"
    ? nothing
    : html`<span class="workboard-card__priority">
        <span aria-hidden="true">${renderPriorityIcon(card.priority)}</span>${formatPriorityLabel(
          card.priority,
        )}
      </span>`;
}

type LabelOverflowMeasurements = {
  labels: readonly string[];
  chipWidths: readonly number[];
  overflowWidth: number;
  gap: number;
};

const labelOverflowMeasurements = new WeakMap<HTMLElement, LabelOverflowMeasurements>();

function labelOverflowRef(labels: readonly string[]) {
  let dispose = () => {};
  return (element: Element | undefined) => {
    dispose();
    if (!(element instanceof HTMLElement)) {
      return;
    }
    const update = () => {
      const chips = [...element.querySelectorAll<HTMLElement>(".workboard-card__label")];
      const overflow = element.querySelector<HTMLElement>(".workboard-card__label-overflow");
      if (!overflow) {
        return;
      }
      let measurements = labelOverflowMeasurements.get(element);
      if (
        !measurements ||
        measurements.labels.length !== labels.length ||
        measurements.labels.some((label, index) => label !== labels[index])
      ) {
        for (const chip of chips) {
          if (chip.hidden) {
            chip.hidden = false;
          }
        }
        const fullOverflow = `+${labels.length}`;
        if (overflow.hidden) {
          overflow.hidden = false;
        }
        if (overflow.textContent !== fullOverflow) {
          overflow.textContent = fullOverflow;
        }
        measurements = {
          labels: [...labels],
          chipWidths: chips.map((chip) => chip.getBoundingClientRect().width),
          overflowWidth: overflow.getBoundingClientRect().width,
          gap: Number.parseFloat(getComputedStyle(element).columnGap) || 0,
        };
        labelOverflowMeasurements.set(element, measurements);
      }
      const available = element.clientWidth;
      const total =
        measurements.chipWidths.reduce((sum, width) => sum + width, 0) +
        measurements.gap * Math.max(0, chips.length - 1);
      let visible = chips.length;
      if (total > available) {
        let used = measurements.overflowWidth;
        visible = 0;
        for (const width of measurements.chipWidths) {
          if (used + measurements.gap + width > available) {
            break;
          }
          used += measurements.gap + width;
          visible++;
        }
      }
      chips.forEach((chip, index) => {
        const hidden = index >= visible;
        if (chip.hidden !== hidden) {
          chip.hidden = hidden;
        }
      });
      const overflowHidden = visible === chips.length;
      if (overflow.hidden !== overflowHidden) {
        overflow.hidden = overflowHidden;
      }
      const overflowText = `+${chips.length - visible}`;
      if (overflow.textContent !== overflowText) {
        overflow.textContent = overflowText;
      }
      const hiddenLabels = labels.slice(visible).join(", ");
      if (overflow.title !== hiddenLabels) {
        overflow.title = hiddenLabels;
      }
      const ariaLabel = t("workboard.cardMoreLabels", {
        count: String(chips.length - visible),
        labels: hiddenLabels,
      });
      if (overflow.getAttribute("aria-label") !== ariaLabel) {
        overflow.setAttribute("aria-label", ariaLabel);
      }
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    const frame = requestAnimationFrame(() => {
      update();
      // Child visibility is controlled by update; observe only the width constraint.
      observer?.observe(element);
    });
    dispose = () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  };
}

export function renderCardMeta(card: WorkboardCard, archived: boolean) {
  if (!card.labels.length && !archived) {
    return nothing;
  }
  return html`<div class="workboard-card__meta">
    ${
      card.labels.length
        ? html`<div class="workboard-card__labels" ${ref(labelOverflowRef(card.labels))}>
            ${card.labels.map(
              (label) =>
                html`<span
                  class="workboard-chip workboard-truncate workboard-card__label"
                  title=${label}
                  >${label}</span
                >`,
            )}
            <span class="workboard-chip workboard-card__label-overflow" hidden></span>
          </div>`
        : nothing
    }
    ${
      archived
        ? html`<span class="workboard-card__archived">${t("workboard.archived")}</span>`
        : nothing
    }
  </div>`;
}

export function renderCardCounts(card: WorkboardCard) {
  const metadata = card.metadata;
  const attempts = metadata?.attempts?.length ?? 0;
  const counts: { count: number; label: string; icon: TemplateResult }[] = [
    {
      count: metadata?.comments?.length ?? 0,
      label: "workboard.badgeComments",
      icon: icons.messageSquare,
    },
    { count: metadata?.proof?.length ?? 0, label: "workboard.badgeProof", icon: icons.fileText },
    {
      count: (metadata?.artifacts?.length ?? 0) + (metadata?.attachments?.length ?? 0),
      label: "workboard.cardFiles",
      icon: icons.paperclip,
    },
    {
      count: metadata?.diagnostics?.length ?? 0,
      label: "workboard.cardWarnings",
      icon: icons.info,
    },
    { count: attempts, label: "workboard.badgeAttempts", icon: icons.refresh },
    {
      count: metadata?.failureCount ?? 0,
      label: "workboard.badgeFailures",
      icon: icons.alertTriangle,
    },
  ].filter((entry) => entry.count > 0);
  return counts.length
    ? html`<div class="workboard-card__counts">
        ${counts.map(
          (entry) => html`<span
            title=${t(entry.label, { count: String(entry.count) })}
            aria-label=${t(entry.label, { count: String(entry.count) })}
          >
            <i aria-hidden="true">${entry.icon}</i>${entry.count}
          </span>`,
        )}
      </div>`
    : nothing;
}

function renderAgentChip(props: WorkboardProps, card: WorkboardCard) {
  const label = cardAgentLabel(card, props.agentsList);
  return html`<span
    class="workboard-agent-chip workboard-agent-avatar"
    title=${label}
    role="img"
    aria-label=${label}
  >
    ${renderAgentAvatar({
      agentId: card.agentId?.trim() || props.agentsList?.defaultId || props.defaultAgentId || "",
      label,
    })}
  </span>`;
}

export function renderCardSession(
  props: WorkboardProps,
  card: WorkboardCard,
  lifecycle: WorkboardLifecycle,
  task: WorkboardTaskSummary | undefined,
  status: SessionStatusPresentation,
) {
  const hasSession = lifecycle.state !== "unlinked" || Boolean(task);
  const sessionName = hasSession
    ? (lifecycle.session?.displayName ??
      lifecycle.session?.label ??
      task?.title ??
      t("workboard.fieldSession"))
    : cardAgentLabel(card, props.agentsList);
  return html`<div class="workboard-card__session workboard-card__session--${status.tone}">
    ${renderAgentChip(props, card)}
    <span class="workboard-card__session-name workboard-truncate" title=${sessionName}
      >${sessionName}</span
    >
    <span class="workboard-card__session-state">
      ${
        hasSession && !status.visible
          ? html`<span
              class="workboard-card__session-marker"
              role="img"
              aria-label=${status.label}
              title=${status.detail}
            >
              ${renderLifecycleIcon(lifecycle, task)}
            </span>`
          : nothing
      }
      ${renderSessionStatus(status, { id: `workboard-card-status-${card.id}`, sessionName })}
    </span>
  </div>`;
}
