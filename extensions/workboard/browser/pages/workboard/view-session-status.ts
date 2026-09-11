import { html, LitElement, nothing, type PropertyValues } from "lit";
import { t } from "../../i18n/index.ts";
import { formatDurationCompact } from "../../lib/format.ts";
import { getCardStaleAgeMs } from "../../lib/workboard/card-alerts.ts";
import { getCardSessionState, type CardSessionState } from "../../lib/workboard/session-state.ts";
import type {
  WorkboardCard,
  WorkboardLifecycle,
  WorkboardTaskSummary,
} from "../../lib/workboard/types.ts";
import { formatLifecycle, taskMatchesLifecycle } from "./view-helpers.ts";

export type SessionStatusPresentation = {
  state: CardSessionState;
  title?: string;
  label: string;
  detail: string;
  tone: "idle" | "live" | "done" | "blocked" | "warning";
  visible: boolean;
};

export function getSessionStatus(
  card: WorkboardCard,
  lifecycle: WorkboardLifecycle,
  task?: WorkboardTaskSummary,
  now = Date.now(),
): SessionStatusPresentation {
  const formatted = formatLifecycle(lifecycle, task);
  const authoritative = task && taskMatchesLifecycle(task, lifecycle) ? task : undefined;
  const state = getCardSessionState(lifecycle, task);
  const sessionName = lifecycle.session?.displayName ?? lifecycle.session?.label ?? task?.title;
  const key = state === "succeeded" ? "done" : state === "timed_out" ? "timedOut" : state;
  const staleAgeMs = state === "stale" ? getCardStaleAgeMs(card, lifecycle, now) : undefined;
  const staleAge =
    staleAgeMs === undefined
      ? undefined
      : (formatDurationCompact(Math.max(1, Math.floor(staleAgeMs / 60_000)) * 60_000) ?? "");
  return {
    state,
    title: staleAge === undefined ? undefined : t("workboard.cardStaleTitle", { age: staleAge }),
    label:
      staleAge !== undefined
        ? t("workboard.cardStaleAge", { age: staleAge })
        : key === "idle" || key === "unlinked"
          ? formatted.label
          : t(`workboard.sessionStatus.${key}`),
    detail: [
      ...new Set(
        [
          state === "succeeded" && !authoritative ? undefined : formatted.detail,
          authoritative?.title !== sessionName ? authoritative?.title : undefined,
          authoritative?.progressSummary,
          authoritative?.terminalSummary,
          authoritative?.error,
          lifecycle.state === "stale" ? card.metadata?.stale?.reason : undefined,
          card.execution?.engine,
          card.execution?.mode,
        ].filter((value): value is string => Boolean(value)),
      ),
    ].join("\n\n"),
    tone: ["stale", "unknown", "unavailable", "ambiguous"].includes(state)
      ? "warning"
      : formatted.tone,
    visible: state !== "idle" && state !== "unlinked" && state !== "running",
  };
}

export function renderSessionStatusBadge(presentation: SessionStatusPresentation) {
  return presentation.visible
    ? html`<span
        class="workboard-session-badge workboard-session-badge--${presentation.tone}"
        title=${presentation.title ?? nothing}
        >${presentation.label}</span
      >`
    : nothing;
}

class WorkboardSessionStatus extends LitElement {
  static override properties = {
    presentation: { attribute: false },
    context: { attribute: false },
  };
  declare presentation: SessionStatusPresentation;
  declare context: { id: string; sessionName: string };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pointerInside = false;
  private open = false;

  protected override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.ownerDocument.addEventListener("scroll", this.onScroll, true);
    this.ownerDocument.addEventListener("keydown", this.onEscape, true);
  }

  override disconnectedCallback() {
    this.dismiss();
    this.ownerDocument.removeEventListener("scroll", this.onScroll, true);
    this.ownerDocument.removeEventListener("keydown", this.onEscape, true);
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues) {
    const previous: unknown = changed.get("context");
    if (
      previous &&
      typeof previous === "object" &&
      "id" in previous &&
      previous.id !== this.context.id
    ) {
      this.dismiss();
    }
    if (!this.presentation.visible) {
      this.dismiss();
    }
  }

  private get trigger() {
    return this.querySelector<HTMLButtonElement>("button");
  }
  private get panel() {
    return this.querySelector<HTMLElement>("[popover]");
  }
  private clearTimer() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  private readonly dismiss = () => {
    this.clearTimer();
    if (this.open && this.panel?.isConnected) {
      this.panel.hidePopover();
    }
    this.open = false;
    this.trigger?.setAttribute("aria-expanded", "false");
  };
  private readonly onScroll = (event: Event) => {
    // Long explanations remain readable while the hover card itself scrolls.
    if (event.target instanceof Node && this.panel?.contains(event.target)) {
      return;
    }
    this.dismiss();
  };
  private readonly onEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !this.open) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.dismiss();
  };
  private show() {
    this.clearTimer();
    const panel = this.panel;
    const trigger = this.trigger;
    if (!this.isConnected || !panel || !trigger || this.open) {
      return;
    }
    panel.showPopover();
    this.open = true;
    trigger.setAttribute("aria-expanded", "true");
    const anchor = trigger.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    const viewport = this.ownerDocument.documentElement;
    panel.style.left = `${Math.max(8, Math.min(anchor.left, viewport.clientWidth - bounds.width - 8))}px`;
    panel.style.top = `${Math.max(8, anchor.bottom + bounds.height + 8 < viewport.clientHeight ? anchor.bottom + 6 : anchor.top - bounds.height - 6)}px`;
  }
  private readonly enter = () => {
    this.pointerInside = true;
    this.clearTimer();
    if (!this.open) {
      this.timer = setTimeout(() => this.show(), 350);
    }
  };
  private readonly leave = () => {
    this.pointerInside = false;
    this.clearTimer();
    this.timer = setTimeout(() => {
      if (!this.pointerInside && !this.contains(this.ownerDocument.activeElement)) {
        this.dismiss();
      }
    }, 150);
  };

  override render() {
    if (!this.presentation.visible) {
      return nothing;
    }
    const panelId = `${this.context.id}-session-status`;
    return html` <button
        class="workboard-session-status__trigger"
        type="button"
        aria-expanded=${String(this.open)}
        aria-describedby=${panelId}
        @pointerenter=${this.enter}
        @pointerleave=${this.leave}
        @focus=${() => this.show()}
        @blur=${this.leave}
        @keydown=${(event: KeyboardEvent) => event.stopPropagation()}
        @click=${(event: MouseEvent) => {
          event.stopPropagation();
          this.show();
        }}
      >
        ${renderSessionStatusBadge(this.presentation)}
      </button>
      <div
        id=${panelId}
        class="workboard-session-status__popover"
        popover="manual"
        role="tooltip"
        @pointerenter=${this.enter}
        @pointerleave=${this.leave}
        @click=${(event: MouseEvent) => event.stopPropagation()}
      >
        <strong class="workboard-session-status__name">${this.context.sessionName}</strong>
        ${renderSessionStatusBadge(this.presentation)}
        <p class="workboard-session-status__detail">${this.presentation.detail}</p>
      </div>`;
  }
}

if (!customElements.get("openclaw-workboard-session-status")) {
  customElements.define("openclaw-workboard-session-status", WorkboardSessionStatus);
}

export function renderSessionStatus(
  presentation: SessionStatusPresentation,
  context: { id: string; sessionName: string },
) {
  return presentation.visible
    ? html`<openclaw-workboard-session-status
        class="workboard-session-status"
        .presentation=${presentation}
        .context=${context}
      ></openclaw-workboard-session-status>`
    : nothing;
}
