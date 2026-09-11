import { LitElement, html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { renderAgentPicker } from "../../components/host-components.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { normalizeDraftLabels } from "../../lib/workboard/card-state.ts";
import {
  getWorkboardState,
  WORKBOARD_PRIORITIES,
  type WorkboardCard,
} from "../../lib/workboard/index.ts";
import { updateWorkboardCardProperties } from "../../lib/workboard/mutations.ts";
import { buildAssignableAgentPickerOptions } from "./agent-filter.ts";
import { moveCardToStatus } from "./view-card-actions.ts";
import {
  formatPriorityLabel,
  formatStatusLabel,
  renderPriorityIcon,
  type WorkboardProps,
} from "./view-helpers.ts";
import { workboardPopoverRef } from "./view-popover.ts";

function closePropertyPicker(input: HTMLInputElement) {
  const panel = input.closest<HTMLElement>("[popover]");
  panel?.hidePopover();
  if (panel?.previousElementSibling instanceof HTMLElement) {
    panel.previousElementSibling.focus({ preventScroll: true });
  }
}

function renderPropertyPicker<T extends string>(params: {
  id: string;
  label: string;
  value: T;
  options: readonly { value: T; label: string; icon: TemplateResult; className?: string }[];
  className?: string;
  disabled: boolean;
  onSelect: (value: T) => void | Promise<unknown>;
}) {
  const selected = params.options.find((option) => option.value === params.value);
  return html`<div class="workboard-detail__property-control">
    <button
      type="button"
      class="workboard-detail__property-trigger ${params.className ?? ""}"
      aria-label=${`${params.label}: ${selected?.label ?? params.value}`}
      aria-haspopup="dialog"
      aria-expanded="false"
      popovertarget=${params.id}
      ?disabled=${params.disabled}
    >
      <span class="workboard-detail__property-icon" aria-hidden="true">${selected?.icon}</span>
      <span>${selected?.label ?? params.value}</span>
      <span class="workboard-detail__property-chevron" aria-hidden="true"
        >${icons.chevronDown}</span
      >
    </button>
    <div
      id=${params.id}
      popover="auto"
      class="workboard-detail__property-menu"
      role="dialog"
      aria-label=${params.label}
      ${ref(workboardPopoverRef())}
    >
      <div role="radiogroup" aria-label=${params.label}>
        ${params.options.map(
          (option) => html`<label
            class="workboard-detail__property-option ${option.className ?? ""}"
          >
            <input
              type="radio"
              name=${params.id}
              value=${option.value}
              .checked=${params.value === option.value}
              ?autofocus=${params.value === option.value}
              ?disabled=${params.disabled}
              @click=${(event: MouseEvent) => {
                if (
                  params.value === option.value &&
                  event.currentTarget instanceof HTMLInputElement
                ) {
                  closePropertyPicker(event.currentTarget);
                }
              }}
              @change=${async (event: Event) => {
                const input = event.currentTarget;
                if (!(input instanceof HTMLInputElement)) {
                  return;
                }
                const trigger = input.closest("[popover]")?.previousElementSibling;
                closePropertyPicker(input);
                if (option.value !== params.value) {
                  await params.onSelect(option.value);
                }
                // A pending mutation disables the trigger. Restore keyboard position
                // after it renders enabled, unless the operator has focused elsewhere.
                requestAnimationFrame(() => {
                  if (
                    trigger instanceof HTMLElement &&
                    trigger.isConnected &&
                    document.activeElement === document.body
                  ) {
                    trigger.focus({ preventScroll: true });
                  }
                });
              }}
            />
            <span class="workboard-detail__property-icon" aria-hidden="true">${option.icon}</span>
            <span>${option.label}</span>
            <span class="workboard-detail__property-check" aria-hidden="true"
              >${params.value === option.value ? icons.check : nothing}</span
            >
          </label>`,
        )}
      </div>
    </div>
  </div>`;
}

export function renderInlinePriority(
  props: WorkboardProps,
  card: WorkboardCard,
  disabled: boolean,
) {
  return renderPropertyPicker({
    id: `workboard-detail-priority-${card.id}`,
    label: t("workboard.fieldPriority"),
    value: card.priority,
    options: WORKBOARD_PRIORITIES.map((priority) => ({
      value: priority,
      label: formatPriorityLabel(priority),
      icon: renderPriorityIcon(priority),
      className: `workboard-detail__priority--${priority}`,
    })),
    className: `workboard-detail__priority workboard-detail__priority--${card.priority}`,
    disabled: disabled || !props.connected || !props.client,
    onSelect: (priority) => {
      return updateWorkboardCardProperties({
        host: props.host,
        client: props.client,
        card,
        patch: { priority },
        requestUpdate: props.onRequestUpdate,
      });
    },
  });
}

export function renderInlineStatus(props: WorkboardProps, card: WorkboardCard, disabled: boolean) {
  const state = getWorkboardState(props.host);
  const statuses = state.statuses.includes(card.status)
    ? state.statuses
    : [card.status, ...state.statuses];
  return renderPropertyPicker({
    id: `workboard-detail-status-${card.id}`,
    label: t("workboard.fieldStatus"),
    value: card.status,
    options: statuses.map((status) => ({
      value: status,
      label: formatStatusLabel(status),
      icon: html`<span class="workboard-status-dot workboard-status-dot--${status}"></span>`,
    })),
    disabled: disabled || !props.connected || !props.client,
    onSelect: (status) => moveCardToStatus(props, card, status),
  });
}

export function renderInlineAgent(props: WorkboardProps, card: WorkboardCard, disabled: boolean) {
  const defaultAgentId = props.agentsList?.defaultId ?? props.defaultAgentId ?? "";
  const options = buildAssignableAgentPickerOptions(
    props.agentsList,
    card.agentId ?? "",
    defaultAgentId,
  );
  return renderAgentPicker(
    {
      options,
      value: card.agentId ?? "",
      accessibleLabel: t("workboard.fieldAgent"),
      disabled: disabled || !props.connected || !props.client,
      onSelect: (agentId) => {
        if (agentId !== (card.agentId ?? "")) {
          void updateWorkboardCardProperties({
            host: props.host,
            client: props.client,
            card,
            patch: { agentId },
            requestUpdate: props.onRequestUpdate,
          });
        }
      },
    },
    "workboard-detail__property-control workboard-detail__agent-picker",
  );
}

type InlineTextField = "title" | "notes" | "labels";
type InlineTextProps = {
  owner: WorkboardProps;
  card: WorkboardCard;
  field: InlineTextField;
  disabled: boolean;
};

class WorkboardInlineText extends LitElement {
  static override properties = {
    props: { attribute: false },
    editing: { state: true },
    value: { state: true },
    saving: { state: true },
  };
  declare props: InlineTextProps;
  declare private editing: boolean;
  declare private value: string;
  declare private saving: boolean;
  private base?: WorkboardCard;

  constructor() {
    super();
    this.editing = false;
    this.value = "";
    this.saving = false;
  }

  override createRenderRoot() {
    return this;
  }

  override willUpdate() {
    if (this.base && this.base.id !== this.props.card.id) {
      this.base = undefined;
      this.editing = false;
      this.value = "";
    }
  }

  private finish = (restoreFocus = true) => {
    const document = this.ownerDocument;
    const previousFocus = document.activeElement;
    this.querySelector<HTMLElement>(".workboard-detail__labels-popover")?.hidePopover();
    this.editing = false;
    void this.updateComplete.then(() => {
      if (
        restoreFocus &&
        this.isConnected &&
        (document.activeElement === previousFocus || document.activeElement === document.body)
      ) {
        this.querySelector<HTMLButtonElement>(".workboard-detail__text-trigger")?.focus();
      }
    });
  };

  private save = async () => {
    if (
      this.saving ||
      this.props.disabled ||
      !this.base ||
      (this.props.field === "title" && !this.value.trim())
    ) {
      return;
    }
    const document = this.ownerDocument;
    let restoreFocus = this.contains(document.activeElement);
    const trackFocus = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && target !== document.body && !this.contains(target)) {
        restoreFocus = false;
      }
    };
    const trackPointer = (event: Event) => {
      if (event.target instanceof Node && !this.contains(event.target)) {
        restoreFocus = false;
      }
    };
    document.addEventListener("focusin", trackFocus);
    document.addEventListener("pointerdown", trackPointer);
    this.saving = true;
    const { owner, field } = this.props;
    const base = this.base;
    const patch =
      field === "labels" ? { labels: normalizeDraftLabels(this.value) } : { [field]: this.value };
    const saved = await updateWorkboardCardProperties({
      host: owner.host,
      client: owner.client,
      card: base,
      patch,
      requestUpdate: owner.onRequestUpdate,
    });
    document.removeEventListener("focusin", trackFocus);
    document.removeEventListener("pointerdown", trackPointer);
    this.saving = false;
    if (this.base?.id !== base.id) {
      return;
    }
    if (saved) {
      this.finish(restoreFocus);
    } else {
      this.base = getWorkboardState(owner.host).cards.find((card) => card.id === base.id) ?? base;
    }
  };

  override render() {
    const { card, field, disabled } = this.props;
    const label = t(
      field === "title"
        ? "workboard.fieldTitle"
        : field === "notes"
          ? "workboard.fieldNotes"
          : "workboard.fieldLabels",
    );
    const labelsPopoverId = `workboard-detail-labels-${card.id}`;
    const content =
      field === "labels"
        ? card.labels.length
          ? html`<span class="workboard-detail__labels"
              >${card.labels.map((value) => html`<span>${value}</span>`)}</span
            >`
          : t("workboard.inlineAddLabels")
        : card[field] || t("workboard.inlineAddDescription");
    const trigger = html`<button
      type="button"
      class="workboard-detail__text-trigger workboard-detail__text-trigger--${field}"
      aria-description=${label}
      aria-haspopup=${field === "labels" ? "dialog" : nothing}
      aria-controls=${field === "labels" ? labelsPopoverId : nothing}
      aria-expanded=${field === "labels" ? String(this.editing) : nothing}
      ?disabled=${disabled}
      @click=${() => {
        this.base = card;
        this.value = field === "labels" ? card.labels.join(", ") : (card[field] ?? "");
        this.editing = true;
        void this.updateComplete.then(() => {
          if (!this.isConnected || !this.editing) {
            return;
          }
          if (field === "labels") {
            this.querySelector<HTMLElement>(".workboard-detail__labels-popover")?.showPopover();
          }
          this.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")?.focus();
        });
      }}
    >
      <span class="workboard-detail__text-value">${content}</span>
    </button>`;
    if (!this.editing && field !== "labels") {
      return trigger;
    }
    const locked = disabled || this.saving;
    const input = (event: InputEvent) => {
      const target = event.currentTarget;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        this.value = target.value;
      }
    };
    const editor = html`<span
      class="workboard-detail__text-editor workboard-detail__text-editor--${field}"
      @keydown=${(event: KeyboardEvent) => {
        if (event.isComposing) {
          if (field === "labels") {
            event.stopPropagation();
          }
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!this.saving) {
            this.finish();
          }
        } else if (
          event.key === "Enter" &&
          (event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLTextAreaElement) &&
          (field !== "notes" || event.metaKey || event.ctrlKey)
        ) {
          event.preventDefault();
          event.stopPropagation();
          void this.save();
        }
      }}
    >
      ${
        field === "notes"
          ? html`<textarea
              class="settings-input"
              aria-label=${label}
              rows="3"
              .value=${this.value}
              ?disabled=${locked}
              @input=${input}
            ></textarea>`
          : html`<input
              class="settings-input"
              aria-label=${label}
              .value=${this.value}
              ?disabled=${locked}
              @input=${input}
            />`
      }
      <span class="workboard-detail__text-actions">
        <button
          type="button"
          class="btn"
          ?disabled=${locked || (field === "title" && !this.value.trim())}
          @click=${this.save}
        >
          ${t("common.save")}
        </button>
        <button type="button" class="btn" ?disabled=${this.saving} @click=${() => this.finish()}>
          ${t("common.cancel")}
        </button>
      </span>
    </span>`;
    return field === "labels"
      ? html`${trigger}
          <div
            id=${labelsPopoverId}
            class="workboard-detail__labels-popover"
            popover="auto"
            role="dialog"
            aria-label=${label}
            ${ref(workboardPopoverRef())}
            @toggle=${(event: Event) => {
              if (
                event.currentTarget instanceof HTMLElement &&
                !event.currentTarget.matches(":popover-open")
              ) {
                this.editing = false;
              }
            }}
          >
            ${this.editing ? editor : nothing}
          </div>`
      : editor;
  }
}
if (!customElements.get("workboard-inline-text")) {
  customElements.define("workboard-inline-text", WorkboardInlineText);
}

export function renderInlineText(
  owner: WorkboardProps,
  card: WorkboardCard,
  field: InlineTextField,
  disabled: boolean,
) {
  return html`<workboard-inline-text
    .props=${{ owner, card, field, disabled: disabled || !owner.connected || !owner.client }}
  ></workboard-inline-text>`;
}
