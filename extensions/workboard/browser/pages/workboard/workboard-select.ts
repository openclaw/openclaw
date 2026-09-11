import { html } from "lit";
import { renderSelectPicker } from "../../components/host-components.ts";
import type { PickerOption } from "../../components/select-picker.ts";

export type WorkboardSelectOption<Value extends string = string> = PickerOption & {
  value: Value;
  icon?: string;
  color?: string;
  boardId?: string;
  disabled?: boolean;
};

export function renderWorkboardSelect<Value extends string>(params: {
  value: Value;
  options: readonly WorkboardSelectOption<Value>[];
  label: string;
  onChange: (value: Value) => void;
  requestUpdate?: () => void;
  className?: string;
  showLabel?: boolean;
  disabled?: boolean;
}) {
  const select = renderSelectPicker(
    {
      value: params.value,
      options: params.options,
      accessibleLabel: params.label,
      disabled: params.disabled,
      onSelect: (value) => {
        params.onChange(value as Value);
        params.requestUpdate?.();
      },
    },
    `workboard-select ${params.className ?? ""}`,
  );
  if (params.showLabel === false) {
    return select;
  }
  return html`
    <div class="workboard-field">
      <span>${params.label}</span>
      ${select}
    </div>
  `;
}
