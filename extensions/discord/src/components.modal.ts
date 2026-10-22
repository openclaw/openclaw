import {
  buildDiscordModalCustomId as buildDiscordModalCustomIdImpl,
  parseDiscordModalCustomIdForInteraction as parseDiscordModalCustomIdForInteractionImpl,
} from "./component-custom-id.js";
import { mapTextInputStyle } from "./components.parse.js";
import type { DiscordModalEntry, DiscordModalFieldDefinition } from "./components.types.js";
import { RoleSelectMenu, StringSelectMenu, UserSelectMenu } from "./internal/components.message.js";
import { CheckboxGroup, Label, Modal, RadioGroup, TextInput } from "./internal/components.modal.js";

function createModalFieldComponent(
  field: DiscordModalFieldDefinition,
): TextInput | StringSelectMenu | UserSelectMenu | RoleSelectMenu | CheckboxGroup | RadioGroup {
  if (field.type === "text") {
    class DynamicTextInput extends TextInput {
      customId = field.id;
      override style = mapTextInputStyle(field.style);
      override placeholder = field.placeholder;
      override required = field.required;
      override minLength = field.minLength;
      override maxLength = field.maxLength;
    }
    return new DynamicTextInput();
  }
  if (field.type === "select" || field.type === "role-select" || field.type === "user-select") {
    const select =
      field.type === "select"
        ? new (class extends StringSelectMenu {
            customId = field.id;
            options = field.options ?? [];
          })()
        : field.type === "role-select"
          ? new (class extends RoleSelectMenu {
              customId = field.id;
            })()
          : new (class extends UserSelectMenu {
              customId = field.id;
            })();
    select.required = field.required;
    select.minValues = field.minValues;
    select.maxValues = field.maxValues;
    select.placeholder = field.placeholder;
    return select;
  }
  const group =
    field.type === "checkbox"
      ? new (class extends CheckboxGroup {
          customId = field.id;
        })()
      : new (class extends RadioGroup {
          customId = field.id;
        })();
  group.options = field.options ?? [];
  group.required = field.required;
  if (field.type === "checkbox") {
    group.minValues = field.minValues;
    group.maxValues = field.maxValues;
  }
  return group;
}

export class DiscordFormModal extends Modal {
  override title: string;
  override customId: string;
  override customIdParser = parseDiscordModalCustomIdForInteractionImpl;

  constructor(params: { modalId: string; title: string; fields: DiscordModalFieldDefinition[] }) {
    super();
    this.title = params.title;
    this.customId = buildDiscordModalCustomIdImpl(params.modalId);
    this.components = params.fields.map((field) => {
      const component = createModalFieldComponent(field);
      class DynamicLabel extends Label {
        override label = field.label;
        override description = field.description;
        override customId = field.id;
      }
      return new DynamicLabel(component);
    });
  }

  async run(): Promise<void> {
    throw new Error("Modal handler is not registered for dynamic forms");
  }
}

export function createDiscordFormModal(entry: DiscordModalEntry): Modal {
  return new DiscordFormModal({
    modalId: entry.id,
    title: entry.title,
    fields: entry.fields,
  });
}
