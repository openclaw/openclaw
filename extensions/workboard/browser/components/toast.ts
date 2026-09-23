import { LitElement, css, html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";

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

class WorkboardToast extends LitElement {
  static override properties = {
    props: { attribute: false },
    visible: { state: true },
  };

  declare props: WorkboardToastProps;
  declare private visible: boolean;
  private lastMessage = "";
  private lastKey: unknown;
  private lastTone: ToastOutcome["tone"] = "info";
  private lastOwner: object = this;
  private timer?: ReturnType<typeof setTimeout>;
  private remaining = 0;
  private deadline = 0;
  private hovered = false;
  private focused = false;

  constructor() {
    super();
    this.props = { message: "" };
    this.visible = false;
  }

  static override styles = css`
    :host {
      position: fixed;
      right: calc(20px + var(--safe-area-right, 0px));
      bottom: calc(20px + var(--safe-area-bottom, 0px));
      z-index: var(--z-toast);
      width: min(380px, calc(100vw - 40px));
    }

    :host([hidden]) {
      display: none;
    }

    .toast {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: 8px 8px 8px 16px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      background: var(--popover);
      color: var(--popover-foreground);
      box-shadow: var(--shadow-lg);
      font: inherit;
      font-size: 13px;
      line-height: 1.5;
    }

    .toast--error {
      border-color: var(--danger);
    }

    .message {
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    button {
      display: grid;
      flex: 0 0 32px;
      width: 32px;
      height: 32px;
      padding: 0;
      place-items: center;
      border: 0;
      border-radius: var(--radius-full);
      corner-shape: round;
      background: transparent;
      color: var(--muted);
      cursor: default;
    }

    button:hover {
      background: var(--bg-muted);
      color: var(--text-strong);
    }

    button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    svg {
      width: 16px;
      height: 16px;
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.resume();
  }

  override disconnectedCallback() {
    this.pause();
    this.hovered = false;
    this.focused = false;
    super.disconnectedCallback();
  }

  protected override willUpdate() {
    const { message, key, tone = "info" } = this.props;
    const owner = this.props.owner ?? this;
    // Owner refreshes must not resurrect dismissed feedback; a new outcome key can.
    if (
      message !== this.lastMessage ||
      !Object.is(key, this.lastKey) ||
      tone !== this.lastTone ||
      owner !== this.lastOwner
    ) {
      this.pause();
      this.lastMessage = message;
      this.lastKey = key;
      this.lastTone = tone;
      this.lastOwner = owner;
      this.visible = Boolean(message);
      this.remaining = tone === "error" ? 10_000 : 6_000;
    }
    if (!this.props.owner) {
      updateWorkboardToastOutcome(owner, this.props);
    }
    const outcome = outcomes.get(owner)?.[tone];
    const dismissed =
      outcome?.message === message &&
      Object.is(outcome.key, key) &&
      outcome.tone === tone &&
      outcome.dismissed;
    this.visible = Boolean(message) && !dismissed;
    if (!this.visible || this.props.hidden) {
      this.hovered = false;
      this.focused = false;
    }
    if (this.props.hidden) {
      this.pause();
    } else {
      this.resume();
    }
  }

  private pause() {
    if (this.timer === undefined) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.remaining = Math.max(0, this.deadline - performance.now());
  }

  private resume() {
    if (
      !this.isConnected ||
      !this.visible ||
      this.props.hidden ||
      this.hovered ||
      this.focused ||
      this.timer !== undefined
    ) {
      return;
    }
    this.deadline = performance.now() + this.remaining;
    this.timer = setTimeout(() => this.dismiss(), this.remaining);
  }

  private dismiss() {
    this.pause();
    const outcome = outcomes.get(this.lastOwner)?.[this.lastTone];
    if (
      outcome?.message === this.lastMessage &&
      Object.is(outcome.key, this.lastKey) &&
      outcome.tone === this.lastTone
    ) {
      outcome.dismissed = true;
    }
    this.visible = false;
    this.hovered = false;
    this.focused = false;
  }

  override render() {
    if (!this.visible) {
      return nothing;
    }
    const error = this.props.tone === "error";
    return html`
      <div
        class=${error ? "toast toast--error" : "toast"}
        @mouseenter=${() => {
          this.hovered = true;
          this.pause();
        }}
        @mouseleave=${() => {
          this.hovered = false;
          this.resume();
        }}
        @focusin=${() => {
          this.focused = true;
          this.pause();
        }}
        @focusout=${(event: FocusEvent) => {
          this.focused =
            event.relatedTarget instanceof Node && this.renderRoot.contains(event.relatedTarget);
          this.resume();
        }}
      >
        <span class="message" role=${error ? "alert" : "status"} aria-atomic="true"
          >${this.props.message}</span
        >
        <button type="button" aria-label=${t("common.close")} @click=${() => this.dismiss()}>
          ${icons.x}
        </button>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-workboard-toast")) {
  customElements.define("openclaw-workboard-toast", WorkboardToast);
}

export function renderWorkboardToast(props: WorkboardToastProps) {
  // The notification producer advances shared state even while its surface is
  // hidden. A dialog omitting a board result is not recovery of that result.
  if (props.owner && props.outcomeSource) {
    updateWorkboardToastOutcome(props.owner, props);
  }
  return html`<openclaw-workboard-toast
    ?hidden=${props.hidden}
    .props=${props}
  ></openclaw-workboard-toast>`;
}
