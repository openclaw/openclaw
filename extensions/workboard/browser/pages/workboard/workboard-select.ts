import type { PickerOption } from "../../components/select-picker.ts";

export type WorkboardSelectOption<Value extends string = string> = PickerOption & {
  value: Value;
  icon?: string;
  color?: string;
  boardId?: string;
  disabled?: boolean;
};
