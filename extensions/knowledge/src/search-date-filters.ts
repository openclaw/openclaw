import type { TimelineInput } from "./chronicle-contract.js";
import { t } from "./i18n/index.js";
import { button, el } from "./page-dom.js";
import { validTemporalDate } from "./temporal-query.js";

export type TemporalSelection = {
  since: string;
  until: string;
  timeField: NonNullable<TimelineInput["timeField"]>;
};
const fields = ["occurred_at", "recorded_at", "updated_at", "due_at"] as const;

/** Validate explicit dates without silently widening an invalid query. */
export function temporalSelectionError(value: TemporalSelection): string {
  for (const key of ["since", "until"] as const) {
    if (value[key] && !validTemporalDate(value[key])) {
      return t(key === "since" ? "knowledge.dates.invalidSince" : "knowledge.dates.invalidUntil");
    }
  }
  const end = Date.parse(value.until) + (value.until.length === 10 ? 86_400_000 - 1 : 0);
  return value.since && value.until && Date.parse(value.since) > end
    ? t("knowledge.dates.sinceAfterUntil")
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
  form.setAttribute("aria-label", t("knowledge.dates.label"));
  const wrap = (name: string, control: HTMLElement) => {
    const label = el("label", name);
    label.append(control);
    form.append(label);
  };
  const field = el("select");
  field.name = "timeField";
  for (const fieldName of fields) {
    const option = el("option", `${t(`knowledge.dates.fields.${fieldName}`)} (${fieldName})`);
    option.value = fieldName;
    field.append(option);
  }
  field.value = value.timeField;
  wrap(t("knowledge.dates.field"), field);
  // Text inputs accept both authored calendar dates and timezone-bearing instants.
  const inputs = { since: el("input"), until: el("input") };
  for (const key of ["since", "until"] as const) {
    const input = inputs[key];
    input.name = key;
    input.value = value[key];
    input.type = "text";
    input.maxLength = 40;
    input.placeholder = t("knowledge.dates.placeholder");
    wrap(t(key === "since" ? "knowledge.dates.since" : "knowledge.dates.until"), input);
  }
  const submit = el("button", t("knowledge.dates.apply"));
  submit.type = "submit";
  const reset = button(
    t("knowledge.dates.clear"),
    () => apply({ since: "", until: "", timeField: "occurred_at" }),
    "knowledge-quiet",
  );
  const help = el("p", t("knowledge.dates.help"), "knowledge-muted knowledge-temporal-help");
  const error = el("p", "", "knowledge-error knowledge-temporal-help");
  error.setAttribute("role", "alert");
  form.append(submit, reset, help, error);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const next = {
      since: inputs.since.value.trim(),
      until: inputs.until.value.trim(),
      // SAFETY: field is the select built above whose option values are exactly the fields.
      timeField: field.value as TemporalSelection["timeField"],
    };
    error.textContent = temporalSelectionError(next);
    if (!error.textContent) {
      apply(next);
    }
  });
  return form;
}
