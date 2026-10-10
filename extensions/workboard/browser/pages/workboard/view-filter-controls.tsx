/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, For, Show } from "solid-js";
import { SelectPicker } from "../../components/host-components.tsx";
import { icons } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import type {
  WorkboardCard,
  WorkboardStatus,
  WorkboardUiState,
} from "../../lib/workboard/index.ts";
import { formatStatusLabel } from "./view-helpers.tsx";
import { workboardPopoverRef } from "./view-popover.ts";
import type { WorkboardSelectOption } from "./workboard-select.ts";
export type ActiveFilter = {
  id: string;
  label: string;
  clear: () => void;
  mobileOnly?: boolean;
};
export function multiFilterLabel<Value extends string>(
  field: string,
  values: ReadonlySet<Value>,
  options: readonly {
    value: Value;
    label: string;
  }[],
  allowExclusion = false,
) {
  const excluded = options.filter((option) => !values.has(option.value));
  const excludeOne = allowExclusion && values.size > 1 && excluded.length === 1;
  const labels = excludeOne ? excluded : options.filter((option) => values.has(option.value));
  return t(excludeOne ? "workboard.filterChipExcludes" : "workboard.filterChipValue", {
    field,
    value: labels.map((option) => option.label).join(", "),
  });
}
export function ActiveFilters(props: { filters: ActiveFilter[]; requestUpdate?: () => void }) {
  let pendingFocus:
    | {
        button: HTMLButtonElement;
        toolbar: Element | null;
        index: number;
      }
    | undefined;
  createEffect(
    () => props.filters,
    () => {
      const pending = pendingFocus;
      pendingFocus = undefined;
      if (!pending) {
        return;
      }
      const doc = pending.button.ownerDocument;
      if (doc.activeElement !== pending.button && doc.activeElement !== doc.body) {
        return;
      }
      const remaining = [
        ...(pending.toolbar?.querySelectorAll<HTMLButtonElement>(
          ".workboard-filter-chip__remove",
        ) ?? []),
      ].filter((candidate) => candidate.getClientRects().length > 0);
      (
        remaining[Math.min(pending.index, remaining.length - 1)] ??
        pending.toolbar?.querySelector<HTMLButtonElement>(".workboard-filter-trigger")
      )?.focus();
    },
  );
  return (
    <Show when={props.filters.length > 0}>
      <div
        class={[
          "workboard-active-filters",
          {
            "workboard-active-filters--mobile": props.filters.every((filter) => filter.mobileOnly),
          },
        ]}
        aria-label={t("workboard.activeFilters")}
      >
        <For each={props.filters} keyed={(filter) => filter.id}>
          {(filter) => (
            <span
              class={[
                "workboard-filter-chip",
                {
                  "workboard-filter-chip--mobile": filter().mobileOnly,
                },
              ]}
            >
              <span class="workboard-filter-chip__label">{filter().label}</span>
              <button
                class="workboard-filter-chip__remove"
                type="button"
                aria-label={t("workboard.removeFilter", {
                  filter: filter().label,
                })}
                onClick={(event: MouseEvent) => {
                  const button = event.currentTarget;
                  if (!(button instanceof HTMLButtonElement)) {
                    return;
                  }
                  const toolbar = button.closest(".workboard-toolbar");
                  const buttons = [
                    ...(toolbar?.querySelectorAll<HTMLElement>(".workboard-filter-chip__remove") ??
                      []),
                  ].filter((candidate) => candidate.getClientRects().length > 0);
                  const index = buttons.indexOf(button);
                  pendingFocus =
                    event.detail === 0
                      ? {
                          button,
                          toolbar,
                          index,
                        }
                      : undefined;
                  filter().clear();
                  props.requestUpdate?.();
                }}
              >
                {icons.x}
              </button>
            </span>
          )}
        </For>
      </div>
    </Show>
  );
}
function toggleStatus(state: WorkboardUiState, status: WorkboardStatus | undefined) {
  if (status === undefined) {
    state.statusFilter.clear();
  } else if (state.statusFilter.has(status)) {
    state.statusFilter.delete(status);
  } else {
    state.statusFilter.add(status);
  }
}
type StatusFilterProps = {
  state: WorkboardUiState;
  requestUpdate?: () => void;
  revision?: number;
};
export function StatusTabs(props: StatusFilterProps) {
  const state = () => {
    void props.revision;
    return props.state;
  };
  return (
    <div class="workboard-status-tabs" role="group" aria-label={t("workboard.fieldStatus")}>
      <For each={[undefined, ...state().statuses]} keyed={(status) => status}>
        {(status) => (
          <button
            type="button"
            aria-pressed={
              status() === undefined
                ? state().statusFilter.size === 0
                  ? "true"
                  : "false"
                : state().statusFilter.has(status()!)
                  ? "true"
                  : "false"
            }
            onClick={() => {
              toggleStatus(state(), status());
              props.requestUpdate?.();
            }}
          >
            {status() === undefined ? t("workboard.allStatuses") : formatStatusLabel(status()!)}
          </button>
        )}
      </For>
    </div>
  );
}
export function MobileStatusPicker(
  props: StatusFilterProps & {
    cards: readonly WorkboardCard[];
  },
) {
  const state = () => {
    void props.revision;
    return props.state;
  };
  const counts = createMemo(() => {
    const result = new Map<WorkboardStatus, number>();
    for (const card of props.cards) {
      result.set(card.status, (result.get(card.status) ?? 0) + 1);
    }
    return result;
  });
  const selected = createMemo(() =>
    state().statuses.filter((status) => state().statusFilter.has(status)),
  );
  const label = () =>
    selected().length ? selected().map(formatStatusLabel).join(", ") : t("workboard.allWork");
  const popoverId = "workboard-status-popover";
  return (
    <div class="workboard-mobile-status">
      <button
        class="btn workboard-mobile-status__trigger"
        type="button"
        popovertarget={popoverId}
        aria-haspopup="dialog"
        aria-expanded="false"
        title={label()}
        aria-label={t("workboard.filterChipValue", {
          field: t("workboard.fieldStatus"),
          value: label(),
        })}
      >
        <span class="workboard-mobile-status__label">{label()}</span>
        <span class="workboard-mobile-status__chevron" aria-hidden="true">
          {icons.chevronsUpDown}
        </span>
      </button>
      <div
        class="workboard-status-popover"
        id={popoverId}
        popover="auto"
        role="dialog"
        aria-label={t("workboard.fieldStatus")}
        ref={workboardPopoverRef("start")}
      >
        <For each={[undefined, ...state().statuses]} keyed={(status) => status}>
          {(status) => (
            <button
              class="workboard-status-option"
              type="button"
              aria-pressed={
                status() === undefined
                  ? selected().length === 0
                    ? "true"
                    : "false"
                  : state().statusFilter.has(status()!)
                    ? "true"
                    : "false"
              }
              onClick={() => {
                toggleStatus(state(), status());
                props.requestUpdate?.();
              }}
            >
              <span class="workboard-status-option__icon" aria-hidden="true">
                {status() === undefined ? (
                  icons.kanban
                ) : (
                  <span class={["workboard-status-dot", `workboard-status-dot--${status()}`]} />
                )}
              </span>
              <span>
                {status() === undefined ? t("workboard.allWork") : formatStatusLabel(status()!)}
              </span>
              <span class="workboard-mobile-status__count">
                {status() === undefined ? props.cards.length : (counts().get(status()!) ?? 0)}
              </span>
              <span class="workboard-status-option__check" aria-hidden="true">
                {icons.check}
              </span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
export function FilterSelect<Value extends string>(props: {
  label: string;
  value: Value;
  options: readonly WorkboardSelectOption<Value>[];
  onChange: (value: Value) => void;
}) {
  return (
    <div class="workboard-filter-row">
      <span>{props.label}</span>
      <SelectPicker
        value={props.value}
        options={props.options}
        accessibleLabel={props.label}
        onSelect={(value) => {
          const option = props.options.find((candidate) => candidate.value === value);
          if (option && !option.disabled) {
            props.onChange(option.value);
          }
        }}
      />
    </div>
  );
}
function DisplayChoice<Field extends "viewMode" | "layout" | "emptyColumnMode">(props: {
  state: WorkboardUiState;
  revision?: number;
  requestUpdate?: () => void;
  field: Field;
  labelKey: string;
  options: readonly (readonly [WorkboardUiState[Field], string, keyof typeof icons, string?])[];
}) {
  const state = () => {
    void props.revision;
    return props.state;
  };
  return (
    <div class="workboard-filter-choice">
      <span class="workboard-filter-section__label">{t(`workboard.${props.labelKey}`)}</span>
      <div class="workboard-view-toggle" role="group" aria-label={t(`workboard.${props.labelKey}`)}>
        <For each={props.options} keyed={(option) => option[0]}>
          {(option) => (
            <button
              class={["btn", { "is-active": state()[props.field] === option()[0] }]}
              type="button"
              aria-pressed={state()[props.field] === option()[0] ? "true" : "false"}
              aria-label={t(`workboard.${option()[3] ?? option()[1]}`)}
              title={t(`workboard.${option()[3] ?? option()[1]}`)}
              onClick={() => {
                state()[props.field] = option()[0];
                if (props.field === "emptyColumnMode") {
                  state().expandedEmptyStatuses.clear();
                }
                props.requestUpdate?.();
              }}
            >
              <span aria-hidden="true">{icons[option()[2]]}</span>
              <span>{t(`workboard.${option()[1]}`)}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
export function DisplayChoices(props: StatusFilterProps) {
  return (
    <>
      <DisplayChoice
        state={props.state}
        revision={props.revision}
        requestUpdate={props.requestUpdate}
        field="viewMode"
        labelKey="filterLayout"
        options={[
          ["board", "viewBoard", "kanban"],
          ["list", "viewList", "list"],
        ]}
      />
      <DisplayChoice
        state={props.state}
        revision={props.revision}
        requestUpdate={props.requestUpdate}
        field="layout"
        labelKey="filterDensity"
        options={[
          ["comfortable", "densityComfortable", "layoutComfortable"],
          ["compact", "densityCompact", "layoutCompact"],
        ]}
      />
      <DisplayChoice
        state={props.state}
        revision={props.revision}
        requestUpdate={props.requestUpdate}
        field="emptyColumnMode"
        labelKey="emptyColumns"
        options={[
          ["show", "emptyColumnsShow", "eye", "showEmptyColumns"],
          ["collapse", "emptyColumnsCollapse", "minimize", "collapseEmptyColumns"],
          ["hide", "emptyColumnsHide", "eyeOff", "hideEmptyColumns"],
        ]}
      />
    </>
  );
}
export function MultiFilter<Value extends string>(props: {
  label: string;
  values: Set<Value>;
  options: readonly {
    value: Value;
    label: string;
    count: number;
    title?: string;
    icon?: () => JSX.Element;
  }[];
  wide?: boolean;
  onChange: () => void;
}) {
  return (
    <div class="workboard-filter-section">
      <div class="workboard-filter-section__heading">
        <span class="workboard-filter-section__label">{props.label}</span>
      </div>
      <div
        class={[
          "workboard-filter-section__options",
          {
            "workboard-filter-section__options--wide": props.wide,
          },
        ]}
        role="group"
        aria-label={props.label}
      >
        <For each={props.options} keyed={(option) => option.value}>
          {(option) => (
            <label
              class={[
                "workboard-filter-option",
                {
                  active: props.values.has(option().value),
                },
              ]}
              title={option().title ?? option().label}
            >
              <input
                type="checkbox"
                checked={props.values.has(option().value)}
                onChange={(event: Event) => {
                  if (!(event.currentTarget instanceof HTMLInputElement)) {
                    return;
                  }
                  if (event.currentTarget.checked) {
                    props.values.add(option().value);
                  } else {
                    props.values.delete(option().value);
                  }
                  props.onChange();
                }}
              />
              <span class="workboard-filter-option__copy">
                {option().icon ? <i aria-hidden="true">{option().icon?.()}</i> : null}
                {option().label}
              </span>
              <span
                class="workboard-filter-option__count"
                aria-label={t(
                  option().count === 1
                    ? "workboard.viewPresetCountOne"
                    : "workboard.viewPresetCount",
                  {
                    count: String(option().count),
                  },
                )}
              >
                {option().count}
              </span>
            </label>
          )}
        </For>
      </div>
    </div>
  );
}
