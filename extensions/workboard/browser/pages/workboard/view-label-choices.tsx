/** @jsxImportSource @solidjs/web */
import { createMemo, createSignal, For, Show } from "solid-js";
import { t } from "../../i18n/index.ts";
import { matchesAgentScope } from "./agent-filter.ts";
import { matchesBoardFilter } from "./board-filter.ts";
import { workboardViewState, type WorkboardProps } from "./view-helpers.tsx";

export function LabelChoices(props: {
  owner: WorkboardProps;
  value: readonly string[];
  onChange: (value: string[]) => void;
  disabled: boolean;
  readOnly?: boolean;
  limit?: number;
  inputRef?: (input: HTMLInputElement) => void;
}) {
  const state = workboardViewState(() => props.owner);
  const [query, setQuery] = createSignal("");
  const options = createMemo(() => {
    const labels = new Set(props.value);
    for (const card of state().cards) {
      if (
        matchesBoardFilter(card, state().boardFilter) &&
        matchesAgentScope(
          card,
          props.owner.agentsList?.defaultId ?? props.owner.defaultAgentId,
          props.owner.scopeAgentId,
        )
      ) {
        for (const label of card.labels) {
          labels.add(label);
        }
      }
    }
    return [...labels].toSorted((a, b) => a.localeCompare(b));
  });
  const visible = createMemo(() =>
    options().filter((label) =>
      label.toLocaleLowerCase().includes(query().trim().toLocaleLowerCase()),
    ),
  );
  const candidate = () => query().trim();
  const canCreate = () => candidate() && !options().includes(candidate());
  const full = () => props.limit !== undefined && props.value.length >= props.limit;
  const create = () => {
    if (!canCreate() || candidate().length > 40 || props.disabled || props.readOnly || full()) {
      return;
    }
    props.onChange([...props.value, candidate()]);
    setQuery("");
  };
  return (
    <div class="workboard-label-choices">
      <input
        class="settings-input"
        type="search"
        aria-label={t("workboard.findLabel")}
        placeholder={t("workboard.findLabel")}
        value={query()}
        ref={props.inputRef}
        disabled={props.disabled}
        readonly={props.readOnly}
        onInput={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            create();
          }
        }}
      />
      <div
        class="workboard-label-choices__list"
        role="group"
        aria-label={t("workboard.fieldLabels")}
      >
        <For each={visible()} keyed={(label) => label}>
          {(label) => (
            <label class="workboard-label-choices__option">
              <input
                type="checkbox"
                checked={props.value.includes(label())}
                disabled={
                  props.disabled || props.readOnly || (full() && !props.value.includes(label()))
                }
                onChange={(event) =>
                  props.onChange(
                    event.currentTarget.checked
                      ? [...props.value, label()]
                      : props.value.filter((value) => value !== label()),
                  )
                }
              />
              <span>{label()}</span>
            </label>
          )}
        </For>
        <Show when={canCreate()}>
          <button
            type="button"
            class="btn workboard-label-choices__create"
            disabled={props.disabled || props.readOnly || full() || candidate().length > 40}
            onClick={create}
          >
            {t("workboard.createLabel", { label: candidate() })}
          </button>
        </Show>
        <Show when={!visible().length && !canCreate()}>
          <span class="muted">
            {t(query().trim() ? "workboard.noMatchingLabels" : "workboard.noKnownLabels")}
          </span>
        </Show>
      </div>
      <Show when={candidate().length > 40}>
        <span class="muted">{t("workboard.labelLengthLimit")}</span>
      </Show>
      <Show when={full()}>
        <span class="muted">{t("workboard.labelLimit")}</span>
      </Show>
    </div>
  );
}
