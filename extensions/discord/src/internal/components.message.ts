import {
  ComponentType,
  type APIStringSelectComponent,
  type APITextDisplayComponent,
} from "discord-api-types/v10";
import {
  type BaseComponent,
  BaseMessageInteractiveComponent,
  clean,
  parseCustomId,
  type ComponentData,
} from "./components.base.js";
import type { BaseComponentInteraction } from "./interactions.js";

export abstract class AnySelectMenu extends BaseMessageInteractiveComponent {
  readonly isV2 = false;
  override defer: BaseMessageInteractiveComponent["defer"] = false;
  override ephemeral: BaseMessageInteractiveComponent["ephemeral"] = false;
  override customIdParser = parseCustomId;
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  disabled = false;
  required?: boolean;
  defaultValues?: unknown[];
  run(_interaction: BaseComponentInteraction, _data: ComponentData): unknown {
    return undefined;
  }
  serializeOptions(): Record<string, unknown> {
    return { type: this.type, default_values: this.defaultValues };
  }
  serialize() {
    return clean({
      ...this.serializeOptions(),
      custom_id: this.customId,
      placeholder: this.placeholder,
      min_values: this.minValues,
      max_values: this.maxValues,
      disabled: this.disabled || undefined,
      required: this.required,
    });
  }
}

export abstract class StringSelectMenu extends AnySelectMenu {
  readonly type = ComponentType.StringSelect;
  abstract options: APIStringSelectComponent["options"];
  override serializeOptions() {
    return { type: this.type, options: this.options };
  }
}

export abstract class UserSelectMenu extends AnySelectMenu {
  readonly type = ComponentType.UserSelect;
}

export abstract class RoleSelectMenu extends AnySelectMenu {
  readonly type = ComponentType.RoleSelect;
}

export interface TextDisplay extends BaseComponent {
  readonly type: ComponentType.TextDisplay;
  readonly isV2: true;
  content?: string;
  serialize(): APITextDisplayComponent;
}
