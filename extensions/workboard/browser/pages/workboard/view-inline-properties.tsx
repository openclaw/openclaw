/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, createEffect, onCleanup, For, untrack } from "solid-js";
import { AgentPicker } from "../../components/host-components.tsx";
import { icons } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import { normalizeDraftLabels } from "../../lib/workboard/card-state.ts";
import {
  getWorkboardState,
  WORKBOARD_PRIORITIES,
  type WorkboardCard,
  type WorkboardPriority,
  type WorkboardStatus,
} from "../../lib/workboard/index.ts";
import { updateWorkboardCardProperties } from "../../lib/workboard/mutations.ts";
import { buildAssignableAgentPickerOptions } from "./agent-filter.ts";
import { moveCardToStatus } from "./view-card-actions.tsx";
import {
  formatPriorityLabel,
  formatStatusLabel,
  PriorityIcon,
  workboardMutationContext,
  type WorkboardProps,
} from "./view-helpers.tsx";
import { liveInputValue } from "./view-input-value.ts";
import { workboardPopoverRef } from "./view-popover.ts";
function closePropertyPicker(input: HTMLInputElement) {
  const panel = input.closest<HTMLElement>("[popover]");
  panel?.hidePopover();
  if (panel?.previousElementSibling instanceof HTMLElement) {
    panel.previousElementSibling.focus({
      preventScroll: true,
    });
  }
}
function PropertyPicker<T extends string>(params: {
  id: string;
  label: string;
  value: T;
  options: readonly {
    value: T;
    label: string;
    icon: () => JSX.Element;
    className?: string;
  }[];
  className?: string;
  disabled: boolean;
  revision?: number;
  onSelect: (value: T) => void | Promise<unknown>;
}) {
  const selected = createMemo(() => params.options.find((option) => option.value === params.value));
  const select = async (input: HTMLInputElement, value: T) => {
    const trigger = input.closest("[popover]")?.previousElementSibling;
    closePropertyPicker(input);
    if (value !== params.value) {
      await params.onSelect(value);
    }
    // A pending mutation disables the trigger. Restore keyboard position
    // after it renders enabled, unless the operator has focused elsewhere.
    requestAnimationFrame(() => {
      if (
        trigger instanceof HTMLElement &&
        trigger.isConnected &&
        document.activeElement === document.body
      ) {
        trigger.focus({
          preventScroll: true,
        });
      }
    });
  };
  return (
    <div class="workboard-detail__property-control">
      <button
        type="button"
        class={["workboard-detail__property-trigger", params.className ?? ""]}
        aria-label={`${params.label}: ${selected()?.label ?? params.value}`}
        aria-haspopup="dialog"
        aria-expanded="false"
        popovertarget={params.id}
        disabled={params.disabled}
      >
        <span class="workboard-detail__property-icon" aria-hidden="true">
          {selected()?.icon()}
        </span>
        <span>{selected()?.label ?? params.value}</span>
        <span class="workboard-detail__property-chevron" aria-hidden="true">
          {icons.chevronDown}
        </span>
      </button>
      <div
        id={params.id}
        popover="auto"
        class="workboard-detail__property-menu"
        role="dialog"
        aria-label={params.label}
        ref={workboardPopoverRef()}
      >
        <div role="radiogroup" aria-label={params.label}>
          <For each={params.options} keyed={(option) => option.value}>
            {(option) => {
              let radio: HTMLInputElement | undefined;
              createEffect(
                () => {
                  void params.revision;
                  void params.disabled;
                  return {
                    checked: params.value === option().value,
                  };
                },
                ({ checked }) => {
                  if (radio) {
                    radio.checked = checked;
                  }
                },
              );
              return (
                <label class={["workboard-detail__property-option", option().className ?? ""]}>
                  <input
                    ref={(element: HTMLInputElement) => {
                      radio = element;
                    }}
                    type="radio"
                    name={params.id}
                    value={option().value}
                    autofocus={params.value === option().value}
                    disabled={params.disabled}
                    onClick={(event: MouseEvent) => {
                      if (
                        params.value === option().value &&
                        event.currentTarget instanceof HTMLInputElement
                      ) {
                        closePropertyPicker(event.currentTarget);
                      }
                    }}
                    onChange={(event: Event) => {
                      const input = event.currentTarget;
                      if (!(input instanceof HTMLInputElement)) {
                        return;
                      }
                      void select(input, option().value);
                    }}
                  />
                  <span class="workboard-detail__property-icon" aria-hidden="true">
                    {option().icon()}
                  </span>
                  <span>{option().label}</span>
                  <span class="workboard-detail__property-check" aria-hidden="true">
                    {params.value === option().value ? icons.check : null}
                  </span>
                </label>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}
export function InlinePriority(input: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  disabled: boolean;
}) {
  return (
    <PropertyPicker<WorkboardPriority>
      {...{
        id: `workboard-detail-priority-${input.card.id}`,
        label: t("workboard.fieldPriority"),
        value: input.card.priority,
        options: WORKBOARD_PRIORITIES.map((priority) => ({
          value: priority,
          label: formatPriorityLabel(priority),
          icon: () => <PriorityIcon priority={priority} />,
          className: `workboard-detail__priority--${priority}`,
        })),
        className: `workboard-detail__priority workboard-detail__priority--${input.card.priority}`,
        disabled: input.disabled || !input.workboard.connected || !input.workboard.client,
        revision: input.workboard.revision,
        onSelect: (priority) => {
          return updateWorkboardCardProperties({
            ...workboardMutationContext(input.workboard),
            card: input.card,
            patch: {
              priority,
            },
          });
        },
      }}
    />
  );
}
export function InlineStatus(input: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  disabled: boolean;
}) {
  const state = () => {
    void input.workboard.revision;
    return getWorkboardState(input.workboard.host);
  };
  const statuses = createMemo(() =>
    state().statuses.includes(input.card.status)
      ? state().statuses
      : [input.card.status, ...state().statuses],
  );
  return (
    <PropertyPicker<WorkboardStatus>
      {...{
        id: `workboard-detail-status-${input.card.id}`,
        label: t("workboard.fieldStatus"),
        value: input.card.status,
        options: statuses().map((status) => ({
          value: status,
          label: formatStatusLabel(status),
          icon: () => <span class={["workboard-status-dot", `workboard-status-dot--${status}`]} />,
        })),
        disabled: input.disabled || !input.workboard.connected || !input.workboard.client,
        revision: input.workboard.revision,
        onSelect: (status) => moveCardToStatus(input.workboard, input.card, status),
      }}
    />
  );
}
export function InlineAgent(input: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  disabled: boolean;
}) {
  const defaultAgentId = createMemo(
    () => input.workboard.agentsList?.defaultId ?? input.workboard.defaultAgentId ?? "",
  );
  const options = createMemo(() =>
    buildAssignableAgentPickerOptions(
      input.workboard.agentsList,
      input.card.agentId ?? "",
      defaultAgentId(),
    ),
  );
  return (
    <AgentPicker
      {...{
        options: options(),
        value: input.card.agentId ?? "",
        accessibleLabel: t("workboard.fieldAgent"),
        disabled: input.disabled || !input.workboard.connected || !input.workboard.client,
        onSelect: (agentId) => {
          if (agentId !== (input.card.agentId ?? "")) {
            void updateWorkboardCardProperties({
              ...workboardMutationContext(input.workboard),
              card: input.card,
              patch: {
                agentId,
              },
            });
          }
        },
      }}
      class={"workboard-detail__property-control workboard-detail__agent-picker"}
    />
  );
}
type InlineTextField = "title" | "notes" | "labels";
type InlineTextProps = {
  owner: WorkboardProps;
  card: WorkboardCard;
  field: InlineTextField;
  disabled: boolean;
  readOnly?: boolean;
};
export type WorkboardInlineText = HTMLElement & {
  readonly draftCardId: string | undefined;
  discardDraft(): void;
  readonly pendingSave: boolean;
  readonly hasUnsavedChanges: boolean;
};
export function InlineText(props: InlineTextProps) {
  let host!: HTMLElement;
  let base: WorkboardCard | undefined;
  let editing = false;
  let value = "";
  let saving = false;
  let disposed = false;
  let disposeSaveFocus: (() => void) | undefined;
  const [revision, setRevision] = createSignal(0);
  const publish = () => setRevision((previous) => previous + 1);
  const isEditing = () => {
    revision();
    return editing;
  };
  const isSaving = () => {
    revision();
    return saving;
  };
  const draftValue = () => {
    revision();
    return value;
  };
  const disabled = () =>
    props.disabled || props.readOnly || !props.owner.connected || !props.owner.client;
  const changed = () => {
    revision();
    if (!base) {
      return false;
    }
    return props.field === "labels"
      ? JSON.stringify(normalizeDraftLabels(value)) !== JSON.stringify(base.labels)
      : value.trim() !== (base[props.field] ?? "").trim();
  };
  const finish = (restoreFocus = true) => {
    base = undefined;
    const doc = host.ownerDocument;
    const previousFocus = doc.activeElement;
    host.querySelector<HTMLElement>(".workboard-detail__labels-popover")?.hidePopover();
    editing = false;
    publish();
    queueMicrotask(() => {
      if (
        restoreFocus &&
        host.isConnected &&
        (doc.activeElement === previousFocus || doc.activeElement === doc.body)
      ) {
        host.querySelector<HTMLElement>(".workboard-detail__text-trigger")?.focus();
      }
    });
  };
  const save = async () => {
    if (saving || disabled() || !base || (props.field === "title" && !value.trim())) {
      return;
    }
    const doc = host.ownerDocument;
    let restoreFocus = host.contains(doc.activeElement);
    const trackFocus = (event: Event) => {
      if (
        event.target instanceof Node &&
        event.target !== doc.body &&
        !host.contains(event.target)
      ) {
        restoreFocus = false;
      }
    };
    const trackPointer = (event: Event) => {
      if (event.target instanceof Node && !host.contains(event.target)) {
        restoreFocus = false;
      }
    };
    doc.addEventListener("focusin", trackFocus);
    doc.addEventListener("pointerdown", trackPointer);
    disposeSaveFocus = () => {
      doc.removeEventListener("focusin", trackFocus);
      doc.removeEventListener("pointerdown", trackPointer);
    };
    saving = true;
    publish();
    const owner = props.owner;
    const field = props.field;
    const observed = base;
    const patch =
      field === "labels"
        ? {
            labels: normalizeDraftLabels(value),
          }
        : {
            [field]: value,
          };
    let saved = false;
    try {
      saved = await updateWorkboardCardProperties({
        ...workboardMutationContext(owner),
        card: observed,
        patch,
      });
    } finally {
      disposeSaveFocus?.();
      disposeSaveFocus = undefined;
      saving = false;
      if (!disposed) {
        publish();
      }
    }
    if (disposed || base?.id !== observed.id) {
      return;
    }
    if (saved) {
      finish(restoreFocus);
    } else {
      base =
        getWorkboardState(owner.host).cards.find((card) => card.id === observed.id) ?? observed;
      publish();
    }
  };
  const openEditor = () => {
    if (!base || !changed()) {
      base = props.card;
      value =
        props.field === "labels" ? props.card.labels.join(", ") : (props.card[props.field] ?? "");
    }
    editing = true;
    publish();
    queueMicrotask(() => {
      if (!host.isConnected || !editing) {
        return;
      }
      if (props.field === "labels") {
        host.querySelector<HTMLElement>(".workboard-detail__labels-popover")?.showPopover();
      }
      host.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")?.focus();
    });
  };
  createEffect(
    () => props.card.id,
    (id) => {
      if (base && base.id !== id) {
        base = undefined;
        editing = false;
        value = "";
        publish();
      }
    },
  );
  onCleanup(() => {
    disposed = true;
    disposeSaveFocus?.();
  });
  const fieldLabel = () =>
    t(
      props.field === "title"
        ? "workboard.fieldTitle"
        : props.field === "notes"
          ? "workboard.fieldNotes"
          : "workboard.fieldLabels",
    );
  const labelsPopoverId = () => `workboard-detail-labels-${props.card.id}`;
  const triggerDisabled = () =>
    disabled() && !(props.field === "labels" && changed() && !isSaving());
  const TriggerContent = () => (
    <span class="workboard-detail__text-value">
      {props.field === "labels" ? (
        props.card.labels.length ? (
          <span class="workboard-detail__labels">
            <For each={props.card.labels} keyed={(label) => label}>
              {(label) => <span>{label()}</span>}
            </For>
          </span>
        ) : (
          t("workboard.inlineAddLabels")
        )
      ) : (
        props.card[props.field] || t("workboard.inlineAddDescription")
      )}
    </span>
  );
  const Trigger = () => (
    <>
      {props.field === "notes" ? (
        <div
          class="workboard-detail__text-trigger workboard-detail__text-trigger--notes"
          role="button"
          tabindex={triggerDisabled() ? -1 : 0}
          aria-description={fieldLabel()}
          aria-disabled={triggerDisabled() ? "true" : undefined}
          onClick={(event: MouseEvent) => {
            const selection = host.ownerDocument.getSelection();
            const target = event.currentTarget;
            if (
              triggerDisabled() ||
              (selection &&
                !selection.isCollapsed &&
                target instanceof Node &&
                [selection.anchorNode, selection.focusNode].some(
                  (node) => node && target.contains(node),
                ))
            ) {
              return;
            }
            openEditor();
          }}
          onKeyDown={(event: KeyboardEvent) => {
            if (triggerDisabled() || (event.key !== "Enter" && event.key !== " ")) {
              return;
            }
            event.preventDefault();
            openEditor();
          }}
        >
          <TriggerContent />
        </div>
      ) : (
        <button
          type="button"
          class={[
            "workboard-detail__text-trigger",
            `workboard-detail__text-trigger--${props.field}`,
          ]}
          aria-description={fieldLabel()}
          aria-haspopup={props.field === "labels" ? "dialog" : undefined}
          aria-controls={props.field === "labels" ? labelsPopoverId() : undefined}
          aria-expanded={props.field === "labels" ? (isEditing() ? "true" : "false") : undefined}
          disabled={triggerDisabled()}
          onClick={openEditor}
        >
          <TriggerContent />
        </button>
      )}
    </>
  );
  const input = (event: InputEvent) => {
    if (
      event.currentTarget instanceof HTMLInputElement ||
      event.currentTarget instanceof HTMLTextAreaElement
    ) {
      value = event.currentTarget.value;
      publish();
    }
  };
  const Editor = () => {
    const bindValue = liveInputValue(draftValue);
    return (
      <span
        class={["workboard-detail__text-editor", `workboard-detail__text-editor--${props.field}`]}
        onKeyDown={(event: KeyboardEvent) => {
          if (event.isComposing) {
            if (props.field === "labels") {
              event.stopPropagation();
            }
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!saving) {
              finish();
            }
          } else if (
            event.key === "Enter" &&
            (event.target instanceof HTMLInputElement ||
              event.target instanceof HTMLTextAreaElement) &&
            (props.field !== "notes" || event.metaKey || event.ctrlKey)
          ) {
            event.preventDefault();
            event.stopPropagation();
            void save();
          }
        }}
      >
        {props.field === "notes" ? (
          <textarea
            class="settings-input"
            aria-label={fieldLabel()}
            rows={12}
            ref={bindValue}
            disabled={isSaving() || (disabled() && !props.readOnly)}
            readonly={props.readOnly}
            onInput={input}
          />
        ) : (
          <input
            class="settings-input"
            aria-label={fieldLabel()}
            ref={bindValue}
            disabled={isSaving() || (disabled() && !props.readOnly)}
            readonly={props.readOnly}
            onInput={input}
          />
        )}
        <span class="workboard-detail__text-actions">
          <button
            type="button"
            class="btn"
            disabled={disabled() || isSaving() || (props.field === "title" && !draftValue().trim())}
            onClick={() => void save()}
          >
            {t("common.save")}
          </button>
          <button type="button" class="btn" disabled={isSaving()} onClick={() => finish()}>
            {t("common.cancel")}
          </button>
        </span>
      </span>
    );
  };
  return (
    <workboard-inline-text
      ref={(element: HTMLElement) => {
        host = element;
        Object.defineProperties(element, {
          draftCardId: {
            configurable: true,
            get: () => base?.id,
          },
          discardDraft: {
            configurable: true,
            value: () => finish(false),
          },
          pendingSave: {
            configurable: true,
            get: () => saving,
          },
          hasUnsavedChanges: {
            configurable: true,
            get: () => untrack(changed),
          },
        });
      }}
    >
      {props.readOnly && !isEditing() && !changed() ? (
        props.field === "labels" ? (
          <div class="workboard-detail__labels">
            <For each={props.card.labels} keyed={(label) => label}>
              {(label) => <span>{label()}</span>}
            </For>
          </div>
        ) : props.field === "title" ? (
          props.card.title
        ) : props.card.notes ? (
          <p class="workboard-detail__description">{props.card.notes}</p>
        ) : null
      ) : props.field === "labels" ? (
        <>
          <Trigger />
          <div
            id={labelsPopoverId()}
            class="workboard-detail__labels-popover"
            popover="auto"
            role="dialog"
            aria-label={fieldLabel()}
            ref={workboardPopoverRef()}
            onToggle={(event: Event) => {
              if (
                event.currentTarget instanceof HTMLElement &&
                !event.currentTarget.matches(":popover-open")
              ) {
                editing = false;
                publish();
              }
            }}
          >
            {isEditing() ? <Editor /> : null}
          </div>
        </>
      ) : isEditing() ? (
        <Editor />
      ) : (
        <Trigger />
      )}
    </workboard-inline-text>
  );
}
