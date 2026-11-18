/** @jsxImportSource @solidjs/web */
import { dynamic, type JSX } from "@solidjs/web";
import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  createEffect,
  onSettled,
  For,
  untrack,
} from "solid-js";
import { AgentPicker } from "../../components/host-components.tsx";
import { icons } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import { listen } from "../../lib/listener.ts";
import { normalizeDraftLabels } from "../../lib/workboard/card-state.ts";
import { updateWorkboardCardProperties } from "../../lib/workboard/mutations.ts";
import { getWorkboardState } from "../../lib/workboard/runtime.ts";
import {
  WORKBOARD_PRIORITIES,
  type WorkboardCard,
  type WorkboardPriority,
  type WorkboardStatus,
} from "../../lib/workboard/types.ts";
import { buildAssignableAgentPickerOptions } from "./agent-filter.ts";
import { moveCardToStatus } from "./view-card-actions.tsx";
import {
  formatPriorityLabel,
  formatStatusLabel,
  PriorityIcon,
  workboardMutationContext,
  workboardViewState,
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
              const checked = () => {
                void params.revision;
                return params.value === option().value;
              };
              return (
                <label class={["workboard-detail__property-option", option().className ?? ""]}>
                  <input
                    checked={checked()}
                    type="radio"
                    name={params.id}
                    value={option().value}
                    autofocus={params.value === option().value}
                    disabled={params.disabled}
                    onClick={(event) => {
                      if (params.value === option().value) {
                        closePropertyPicker(event.currentTarget);
                      }
                    }}
                    onChange={(event) => {
                      void select(event.currentTarget, option().value);
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
  const state = workboardViewState(() => input.workboard);
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
  register?: (editor: WorkboardInlineText) => () => void;
};
export type WorkboardInlineText = {
  readonly draftCardId: string | undefined;
  discardDraft(): void;
  readonly pendingSave: boolean;
  readonly hasUnsavedChanges: boolean;
};
export function InlineText(props: InlineTextProps) {
  let host!: HTMLElement;
  let trigger: HTMLElement | undefined;
  let popover: HTMLElement | undefined;
  let editorInput: HTMLInputElement | HTMLTextAreaElement | undefined;
  let base: WorkboardCard | undefined;
  let editing = false;
  let value = "";
  let busy = false;
  const [saving, setSaving] = createOptimistic(false);
  const presentSaving = action(function* (
    pending: Promise<boolean>,
  ): Generator<Promise<boolean>, boolean, boolean> {
    setSaving(true);
    return yield pending;
  });
  let disposed = false;
  let disposeSaveFocus: (() => void) | undefined;
  const [revision, setRevision] = createSignal(0);
  const publish = () => setRevision((previous) => previous + 1);
  const isEditing = () => {
    revision();
    return editing;
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
    popover?.hidePopover();
    editing = false;
    publish();
    queueMicrotask(() => {
      if (
        restoreFocus &&
        host.isConnected &&
        (doc.activeElement === previousFocus || doc.activeElement === doc.body)
      ) {
        trigger?.focus();
      }
    });
  };
  const save = async () => {
    if (busy || disabled() || !base || (props.field === "title" && !value.trim())) {
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
    const stopFocus = listen(doc, "focusin", trackFocus);
    const stopPointer = listen(doc, "pointerdown", trackPointer);
    disposeSaveFocus = () => {
      stopFocus();
      stopPointer();
    };
    busy = true;
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
      const pending = updateWorkboardCardProperties({
        ...workboardMutationContext(owner),
        card: observed,
        patch,
      });
      // Publish the owner's busy state before joining the saving transition.
      await Promise.resolve();
      saved = await presentSaving(pending);
    } finally {
      disposeSaveFocus?.();
      disposeSaveFocus = undefined;
      busy = false;
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
        popover?.showPopover();
      }
      editorInput?.focus();
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
  onSettled(() => {
    const unregister = props.register?.({
      get draftCardId() {
        return base?.id;
      },
      discardDraft: () => finish(false),
      get pendingSave() {
        return busy;
      },
      get hasUnsavedChanges() {
        return untrack(changed);
      },
    });
    return () => {
      disposed = true;
      disposeSaveFocus?.();
      unregister?.();
    };
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
  const triggerDisabled = () => disabled() && !(props.field === "labels" && changed() && !saving());
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
          ref={(element) => {
            trigger = element;
          }}
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
          ref={(element) => {
            trigger = element;
          }}
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
  const input: JSX.InputEventHandler<HTMLInputElement | HTMLTextAreaElement, InputEvent> = (
    event,
  ) => {
    value = event.currentTarget.value;
    publish();
  };
  const Editor = () => {
    const bindValue = liveInputValue(draftValue);
    const Input = dynamic(() => (props.field === "notes" ? "textarea" : "input"));
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
            if (!busy) {
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
        <Input
          class="settings-input"
          aria-label={fieldLabel()}
          rows={props.field === "notes" ? 12 : undefined}
          ref={(element: HTMLInputElement | HTMLTextAreaElement) => {
            bindValue(element);
            editorInput = element;
          }}
          disabled={saving() || (disabled() && !props.readOnly)}
          readonly={props.readOnly}
          onInput={input}
        />
        <span class="workboard-detail__text-actions">
          <button
            type="button"
            class="btn"
            disabled={saving() || disabled() || (props.field === "title" && !draftValue().trim())}
            onClick={() => void save()}
          >
            {t("common.save")}
          </button>
          <button type="button" class="btn" disabled={saving()} onClick={() => finish()}>
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
            ref={[
              workboardPopoverRef(),
              (element) => {
                popover = element;
              },
            ]}
            onToggle={(event) => {
              if (!event.currentTarget.matches(":popover-open")) {
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
