/** @jsxImportSource @solidjs/web */
import { createEffect, onCleanup, onSettled } from "solid-js";
import { t } from "../../i18n/index.ts";
import { formatDurationCompact } from "../../lib/format.ts";
import { getCardStaleAgeMs } from "../../lib/workboard/card-alerts.ts";
import { getCardSessionState, type CardSessionState } from "../../lib/workboard/session-state.ts";
import type { WorkboardCard, WorkboardLifecycle } from "../../lib/workboard/types.ts";
import { formatLifecycle } from "./view-helpers.tsx";
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
  now = Date.now(),
): SessionStatusPresentation {
  const formatted = formatLifecycle(lifecycle);
  const state = getCardSessionState(lifecycle);
  const key = state === "succeeded" ? "done" : state === "timed_out" ? "timedOut" : state;
  const staleAgeMs = state === "stale" ? getCardStaleAgeMs(card, lifecycle, now) : undefined;
  const staleAge =
    staleAgeMs === undefined
      ? undefined
      : (formatDurationCompact(Math.max(1, Math.floor(staleAgeMs / 60_000)) * 60_000) ?? "");
  return {
    state,
    title:
      staleAge === undefined
        ? undefined
        : t("workboard.cardStaleTitle", {
            age: staleAge,
          }),
    label:
      staleAge !== undefined
        ? t("workboard.cardStaleAge", {
            age: staleAge,
          })
        : key === "idle" || key === "unlinked"
          ? formatted.label
          : t(`workboard.sessionStatus.${key}`),
    detail: [
      ...new Set(
        [
          state === "succeeded" ? undefined : formatted.detail,
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
export function SessionStatusBadge(props: { presentation: SessionStatusPresentation }) {
  return (
    <>
      {props.presentation.visible ? (
        <span
          class={`workboard-session-badge workboard-session-badge--${props.presentation.tone}`}
          title={props.presentation.title}
        >
          {props.presentation.label}
        </span>
      ) : null}
    </>
  );
}
export function SessionStatus(props: {
  presentation: SessionStatusPresentation;
  context: {
    id: string;
    sessionName: string;
  };
}) {
  let host!: HTMLElement;
  let trigger: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pointerInside = false;
  let open = false;
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const dismiss = () => {
    clearTimer();
    if (open && panel?.isConnected) {
      panel.hidePopover();
    }
    open = false;
    trigger?.setAttribute("aria-expanded", "false");
  };
  const show = () => {
    clearTimer();
    if (!host.isConnected || !panel || !trigger || open) {
      return;
    }
    panel.showPopover();
    open = true;
    trigger.setAttribute("aria-expanded", "true");
    const anchor = trigger.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    const viewport = host.ownerDocument.documentElement;
    panel.style.left = `${Math.max(8, Math.min(anchor.left, viewport.clientWidth - bounds.width - 8))}px`;
    panel.style.top = `${Math.max(8, anchor.bottom + bounds.height + 8 < viewport.clientHeight ? anchor.bottom + 6 : anchor.top - bounds.height - 6)}px`;
  };
  const enter = () => {
    pointerInside = true;
    clearTimer();
    if (!open) {
      timer = setTimeout(show, 350);
    }
  };
  const leave = () => {
    pointerInside = false;
    clearTimer();
    timer = setTimeout(() => {
      if (!pointerInside && !host.contains(host.ownerDocument.activeElement)) {
        dismiss();
      }
    }, 150);
  };
  createEffect(() => `${props.context.id}:${props.presentation.visible}`, dismiss);
  onSettled(() => {
    const doc = host.ownerDocument;
    const outside = (event: Event) => {
      if (!event.composedPath().includes(host)) {
        dismiss();
      }
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node && panel?.contains(event.target))) {
        dismiss();
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }
    };
    doc.addEventListener("scroll", scroll, true);
    doc.addEventListener("pointerdown", outside, true);
    doc.addEventListener("keydown", escape, true);
    return () => {
      dismiss();
      doc.removeEventListener("scroll", scroll, true);
      doc.removeEventListener("pointerdown", outside, true);
      doc.removeEventListener("keydown", escape, true);
    };
  });
  onCleanup(dismiss);
  return (
    <openclaw-workboard-session-status
      ref={(element) => {
        host = element;
      }}
      class="workboard-session-status"
    >
      {props.presentation.visible ? (
        <>
          <button
            ref={(element) => {
              trigger = element;
            }}
            class="workboard-session-status__trigger"
            type="button"
            aria-expanded="false"
            aria-describedby={`${props.context.id}-session-status`}
            onPointerEnter={enter}
            onPointerLeave={leave}
            onFocus={show}
            onBlur={leave}
            onKeyDown={(event: KeyboardEvent) => event.stopPropagation()}
            onClick={(event: MouseEvent) => {
              event.stopPropagation();
              show();
            }}
          >
            <SessionStatusBadge presentation={props.presentation} />
          </button>
          <div
            ref={(element) => {
              panel = element;
            }}
            id={`${props.context.id}-session-status`}
            class="workboard-session-status__popover"
            popover="manual"
            role="tooltip"
            onPointerEnter={enter}
            onPointerLeave={leave}
            onClick={(event: MouseEvent) => event.stopPropagation()}
          >
            <strong class="workboard-session-status__name">{props.context.sessionName}</strong>
            <SessionStatusBadge presentation={props.presentation} />
            <p class="workboard-session-status__detail">{props.presentation.detail}</p>
          </div>
        </>
      ) : null}
    </openclaw-workboard-session-status>
  );
}
