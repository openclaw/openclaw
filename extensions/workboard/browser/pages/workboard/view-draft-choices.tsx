/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import type { WorkboardSelectOption } from "./workboard-select.ts";

export function DraftChoices<Value extends string>(props: {
  name: "status" | "priority";
  radioName?: string;
  label: JSX.Element;
  labelId?: string;
  value: Value | "";
  options: readonly WorkboardSelectOption<Value>[];
  renderIcon?: (value: Value) => JSX.Element;
  disabled: boolean;
  onChange: (value: Value) => void;
}) {
  return (
    <fieldset
      class={["workboard-choice-field", { "workboard-field--wide": props.name === "status" }]}
      aria-labelledby={props.labelId}
      disabled={props.disabled}
    >
      <legend>{props.label}</legend>
      <div class={`workboard-segments workboard-segments--${props.name}`}>
        <For each={props.options} keyed={(option) => option.value}>
          {(option) => (
            <label
              class={[
                "workboard-segment",
                { [`workboard-segment--${option().value}`]: props.name === "status" },
              ]}
            >
              <input
                type="radio"
                name={props.radioName ?? props.name}
                value={option().value}
                checked={props.value === option().value}
                onChange={() => props.onChange(option().value)}
              />
              <span>
                {props.renderIcon ? (
                  <i aria-hidden="true">{props.renderIcon(option().value)}</i>
                ) : undefined}
                {option().label}
              </span>
            </label>
          )}
        </For>
      </div>
    </fieldset>
  );
}
