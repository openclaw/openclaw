import type { ControlUiComponents } from "openclaw/plugin-sdk/control-ui";

type PickerOption = Parameters<ControlUiComponents["mountSelectPicker"]>[1]["options"][number];

export type WorkboardSelectOption<Value extends string = string> = PickerOption & {
  value: Value;
  icon?: string;
  color?: string;
  boardId?: string;
};
