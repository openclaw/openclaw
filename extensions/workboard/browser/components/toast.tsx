/** @jsxImportSource @solidjs/web */
import { createEffect, createSignal, onCleanup, onSettled, Show } from "solid-js";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.tsx";
import "./toast.css";

type WorkboardToastProps = {
  message: string;
  hidden?: boolean;
  key?: unknown;
  tone?: "info" | "error";
  owner?: object;
  outcomeSource?: boolean;
};

type ToastOutcome = {
  message: string;
  key: unknown;
  tone: "info" | "error";
  dismissed: boolean;
};

const outcomes = new WeakMap<object, Partial<Record<ToastOutcome["tone"], ToastOutcome>>>();

export function updateWorkboardToastOutcome(owner: object, props: WorkboardToastProps) {
  const { message, key, tone = "info" } = props;
  const ownerOutcomes = outcomes.get(owner) ?? {};
  // Recovery starts a new error lifetime without resurrecting an older result.
  if (tone === "info") {
    delete ownerOutcomes.error;
  }
  const previous = ownerOutcomes[tone];
  if (!previous || previous.message !== message || !Object.is(previous.key, key)) {
    ownerOutcomes[tone] = { message, key, tone, dismissed: false };
  }
  outcomes.set(owner, ownerOutcomes);
}

export function WorkboardToast(props: WorkboardToastProps) {
  const localOwner = {};
  const [visible, setVisible] = createSignal(false);
  let host: HTMLElement | undefined;
  let lastMessage = "";
  let lastKey: unknown;
  let lastTone: ToastOutcome["tone"] = "info";
  let lastOwner = localOwner;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remaining = 0;
  let deadline = 0;
  let hovered = false;
  let focused = false;
  let shown = false;
  let hidden = false;

  function pause() {
    if (timer === undefined) {
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    remaining = Math.max(0, deadline - performance.now());
  }

  function resume() {
    if (!host?.isConnected || !shown || hidden || hovered || focused || timer !== undefined) {
      return;
    }
    deadline = performance.now() + remaining;
    timer = setTimeout(dismiss, remaining);
  }

  function dismiss() {
    pause();
    const outcome = outcomes.get(lastOwner)?.[lastTone];
    if (
      outcome?.message === lastMessage &&
      Object.is(outcome.key, lastKey) &&
      outcome.tone === lastTone
    ) {
      outcome.dismissed = true;
    }
    shown = false;
    setVisible(false);
    hovered = false;
    focused = false;
  }

  createEffect(
    () => ({
      message: props.message,
      key: props.key,
      tone: props.tone ?? "info",
      owner: props.owner ?? localOwner,
      hidden: props.hidden,
      outcomeSource: props.outcomeSource,
    }),
    (next) => {
      hidden = Boolean(next.hidden);
      if (
        next.message !== lastMessage ||
        !Object.is(next.key, lastKey) ||
        next.tone !== lastTone ||
        next.owner !== lastOwner
      ) {
        pause();
        lastMessage = next.message;
        lastKey = next.key;
        lastTone = next.tone;
        lastOwner = next.owner;
        remaining = next.tone === "error" ? 10_000 : 6_000;
      }
      // Only the producer advances shared outcomes. An empty dialog is not recovery.
      if (next.owner === localOwner || next.outcomeSource) {
        updateWorkboardToastOutcome(next.owner, next);
      }
      const outcome = outcomes.get(next.owner)?.[next.tone];
      shown =
        Boolean(next.message) &&
        !(
          outcome?.message === next.message &&
          Object.is(outcome.key, next.key) &&
          outcome.dismissed
        );
      setVisible(shown);
      if (!shown || hidden) {
        hovered = false;
        focused = false;
        pause();
      } else {
        resume();
      }
    },
  );
  onSettled(resume);
  onCleanup(pause);

  return (
    <openclaw-workboard-toast
      ref={(element) => {
        host = element;
      }}
      hidden={props.hidden}
    >
      <Show when={visible()}>
        <div
          class={props.tone === "error" ? "toast toast--error" : "toast"}
          onMouseEnter={() => {
            hovered = true;
            pause();
          }}
          onMouseLeave={() => {
            hovered = false;
            resume();
          }}
          onFocusIn={() => {
            focused = true;
            pause();
          }}
          onFocusOut={(event: FocusEvent) => {
            focused =
              event.relatedTarget instanceof Node && Boolean(host?.contains(event.relatedTarget));
            resume();
          }}
        >
          <span
            class="message"
            role={props.tone === "error" ? "alert" : "status"}
            aria-atomic="true"
          >
            {props.message}
          </span>
          <button type="button" aria-label={t("common.close")} onClick={dismiss}>
            {icons.x}
          </button>
        </div>
      </Show>
    </openclaw-workboard-toast>
  );
}

export function WorkboardErrorToast(props: {
  owner: object;
  error: string | null | undefined;
  hidden?: boolean;
}) {
  return (
    <WorkboardToast
      owner={props.owner}
      message={props.error ?? ""}
      key={props.error}
      tone="error"
      hidden={props.hidden}
    />
  );
}
