import type { TimelineInput } from "./chronicle-contract.js";
import { validTemporalDate } from "./temporal-query.js";

export type TemporalSelection = {
  since: string;
  until: string;
  timeField: NonNullable<TimelineInput["timeField"]>;
};
const fields = {
  occurred_at: "Occurred",
  recorded_at: "Recorded",
  updated_at: "Updated",
  due_at: "Due",
} as const;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  if (className) {
    node.className = className;
  }
  return node;
};
const button = (text: string, run: () => void, className = "knowledge-button") => {
  const node = el("button", text, className);
  node.type = "button";
  node.addEventListener("click", run);
  return node;
};

/** Validate explicit dates without silently widening an invalid query. */
export function temporalSelectionError(value: TemporalSelection): string {
  for (const key of ["since", "until"] as const) {
    if (value[key] && !validTemporalDate(value[key])) {
      return `${key === "since" ? "Since" : "Until"} must be a real YYYY-MM-DD date or ISO timestamp with seconds and an explicit timezone.`;
    }
  }
  const end = Date.parse(value.until) + (value.until.length === 10 ? 86_400_000 - 1 : 0);
  return value.since && value.until && Date.parse(value.since) > end
    ? "Since must not be after Until."
    : "";
}

/** Build the explicit date predicates for text search. */
export function temporalQuery(value: TemporalSelection) {
  return {
    timeField: value.timeField,
    ...(value.since ? { since: value.since } : {}),
    ...(value.until ? { until: value.until } : {}),
  };
}

/** Explicit-submit filters keep draft edits intact during background refreshes. */
export function temporalFilterForm(
  value: TemporalSelection,
  apply: (next: TemporalSelection) => void,
): HTMLFormElement {
  const form = el("form", undefined, "knowledge-temporal-filters");
  form.setAttribute("aria-label", "Search date filters");
  const wrap = (name: string, control: HTMLElement) => {
    const label = el("label", name);
    label.append(control);
    form.append(label);
  };
  const field = el("select");
  field.name = "timeField";
  for (const [fieldName, name] of Object.entries(fields)) {
    const option = el("option", `${name} (${fieldName})`);
    option.value = fieldName;
    field.append(option);
  }
  field.value = value.timeField;
  wrap("Date field", field);
  // Text inputs accept both authored calendar dates and timezone-bearing instants.
  const inputs = { since: el("input"), until: el("input") };
  for (const key of ["since", "until"] as const) {
    const input = inputs[key];
    input.name = key;
    input.value = value[key];
    input.type = "text";
    input.maxLength = 40;
    input.placeholder = "YYYY-MM-DD or ISO timestamp";
    wrap(key === "since" ? "Since (inclusive)" : "Until (inclusive)", input);
  }
  const submit = el("button", "Apply dates");
  submit.type = "submit";
  const reset = button(
    "Clear filters",
    () => apply({ since: "", until: "", timeField: "occurred_at" }),
    "knowledge-quiet",
  );
  const help = el(
    "p",
    "Dates use UTC range boundaries; Until includes the whole calendar day. Occurred never falls back to recorded time.",
    "knowledge-muted knowledge-temporal-help",
  );
  const error = el("p", "", "knowledge-error knowledge-temporal-help");
  error.setAttribute("role", "alert");
  form.append(submit, reset, help, error);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const next = {
      since: inputs.since.value.trim(),
      until: inputs.until.value.trim(),
      // SAFETY: field is the select built above whose option values are exactly the keys of fields.
      timeField: field.value as TemporalSelection["timeField"],
    };
    error.textContent = temporalSelectionError(next);
    if (!error.textContent) {
      apply(next);
    }
  });
  return form;
}
