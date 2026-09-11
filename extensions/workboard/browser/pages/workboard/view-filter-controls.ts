import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { renderSelectPicker } from "../../components/host-components.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import type { WorkboardUiState } from "../../lib/workboard/index.ts";
import { formatStatusLabel } from "./view-helpers.ts";
import type { WorkboardSelectOption } from "./workboard-select.ts";

export type ActiveFilter = { id: string; label: string; clear: () => void };

export function multiFilterLabel<Value extends string>(
  field: string,
  values: ReadonlySet<Value>,
  options: readonly { value: Value; label: string }[],
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

export function renderActiveFilters(
  filters: ActiveFilter[],
  requestUpdate: (() => void) | undefined,
) {
  return html`<div class="workboard-active-filters" aria-label=${t("workboard.activeFilters")}>
    ${repeat(
      filters,
      (filter) => filter.id,
      (filter) => html` <span class="workboard-filter-chip">
        <span class="workboard-filter-chip__label">${filter.label}</span>
        <button
          class="workboard-filter-chip__remove"
          type="button"
          aria-label=${t("workboard.removeFilter", { filter: filter.label })}
          @click=${(event: MouseEvent) => {
            const button = event.currentTarget;
            if (!(button instanceof HTMLButtonElement)) {
              return;
            }
            const toolbar = button.closest(".workboard-toolbar");
            const buttons = [
              ...(toolbar?.querySelectorAll(".workboard-filter-chip__remove") ?? []),
            ];
            const index = buttons.indexOf(button);
            filter.clear();
            requestUpdate?.();
            if (event.detail === 0) {
              queueMicrotask(() => {
                const remaining = toolbar?.querySelectorAll<HTMLButtonElement>(
                  ".workboard-filter-chip__remove",
                );
                (
                  remaining?.[Math.min(index, remaining.length - 1)] ??
                  toolbar?.querySelector<HTMLButtonElement>(".workboard-filter-trigger")
                )?.focus();
              });
            }
          }}
        >
          ${icons.x}
        </button>
      </span>`,
    )}
  </div>`;
}

export function renderStatusTabs(state: WorkboardUiState, requestUpdate: (() => void) | undefined) {
  return html`<div
    class="workboard-status-tabs"
    role="group"
    aria-label=${t("workboard.fieldStatus")}
  >
    <button
      type="button"
      aria-pressed=${state.statusFilter.size === 0}
      @click=${() => {
        state.statusFilter.clear();
        requestUpdate?.();
      }}
    >
      ${t("workboard.allStatuses")}
    </button>
    ${state.statuses.map(
      (status) => html`<button
        type="button"
        aria-pressed=${state.statusFilter.has(status)}
        @click=${() => {
          if (state.statusFilter.has(status)) {
            state.statusFilter.delete(status);
          } else {
            state.statusFilter.add(status);
          }
          requestUpdate?.();
        }}
      >
        ${formatStatusLabel(status)}
      </button>`,
    )}
  </div>`;
}

export function renderFilterSelect<Value extends string>(params: {
  label: string;
  value: Value;
  options: readonly WorkboardSelectOption<Value>[];
  onChange: (value: Value) => void;
}) {
  return html`<div class="workboard-filter-row">
    <span>${params.label}</span>
    ${renderSelectPicker({
      value: params.value,
      options: params.options,
      accessibleLabel: params.label,
      onSelect: (value) => {
        const option = params.options.find((candidate) => candidate.value === value);
        if (option && !option.disabled) {
          params.onChange(option.value);
        }
      },
    })}
  </div>`;
}

export function renderFilterChoices<Value extends string>(params: {
  label: string;
  value: Value;
  options: readonly { value: Value; label: string; icon: keyof typeof icons; title?: string }[];
  onChange: (value: Value) => void;
}) {
  return html`<div class="workboard-filter-choice">
    <span class="workboard-filter-section__label">${params.label}</span>
    <div class="workboard-view-toggle" role="group" aria-label=${params.label}>
      ${params.options.map(
        (option) => html`<button
          class="btn ${params.value === option.value ? "is-active" : ""}"
          type="button"
          aria-pressed=${params.value === option.value}
          aria-label=${option.title ?? option.label}
          title=${option.title ?? option.label}
          @click=${() => params.onChange(option.value)}
        >
          <span aria-hidden="true">${icons[option.icon]}</span>
          <span>${option.label}</span>
        </button>`,
      )}
    </div>
  </div>`;
}

export function renderMultiFilter<Value extends string>(params: {
  label: string;
  values: Set<Value>;
  options: readonly {
    value: Value;
    label: string;
    count: number;
    title?: string;
    icon?: unknown;
  }[];
  wide?: boolean;
  onChange: () => void;
}) {
  return html`<div class="workboard-filter-section">
    <div class="workboard-filter-section__heading">
      <span class="workboard-filter-section__label">${params.label}</span>
    </div>
    <div
      class="workboard-filter-section__options ${
        params.wide ? "workboard-filter-section__options--wide" : ""
      }"
      role="group"
      aria-label=${params.label}
    >
      ${params.options.map(
        (option) => html`<label
          class="workboard-filter-option ${params.values.has(option.value) ? "active" : ""}"
          title=${option.title ?? option.label}
        >
          <input
            type="checkbox"
            .checked=${params.values.has(option.value)}
            @change=${(event: Event) => {
              if (!(event.currentTarget instanceof HTMLInputElement)) {
                return;
              }
              if (event.currentTarget.checked) {
                params.values.add(option.value);
              } else {
                params.values.delete(option.value);
              }
              params.onChange();
            }}
          />
          <span class="workboard-filter-option__copy"
            >${
              option.icon ? html`<i aria-hidden="true">${option.icon}</i>` : nothing
            }${option.label}</span
          >
          <span
            class="workboard-filter-option__count"
            aria-label=${t(
              option.count === 1 ? "workboard.viewPresetCountOne" : "workboard.viewPresetCount",
              { count: String(option.count) },
            )}
            >${option.count}</span
          >
        </label>`,
      )}
    </div>
  </div>`;
}
