import type { ControlUiComponents } from "openclaw/plugin-sdk/control-ui";

export type WorkboardSelectOption<Value extends string = string> = Parameters<
  ControlUiComponents["mountSelectPicker"]
>[1]["options"][number] & {
  value: Value;
};
