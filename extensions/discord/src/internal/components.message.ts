import {
  ButtonStyle,
  ComponentType,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIChannelSelectComponent,
  type APIComponentInMessageActionRow,
  type APIContainerComponent,
  type APIFileComponent,
  type APIMediaGalleryComponent,
  type APISectionComponent,
  type APISeparatorComponent,
  type APIStringSelectComponent,
  type APITextDisplayComponent,
  type APIThumbnailComponent,
} from "discord-api-types/v10";
import {
  BaseComponent,
  BaseMessageInteractiveComponent,
  clean,
  colorToNumber,
} from "./components.base.js";

abstract class BaseButton extends BaseMessageInteractiveComponent {
  readonly type = ComponentType.Button;
  abstract label: string;
  emoji?: { name: string; id?: string; animated?: boolean };
  style: ButtonStyle = ButtonStyle.Primary;
  disabled = false;
  serialize(): APIButtonComponent {
    const link = this instanceof LinkButton;
    return clean({
      type: this.type,
      style: this.style,
      custom_id: link ? undefined : this.customId,
      label: this.label,
      emoji: this.emoji,
      disabled: this.disabled || undefined,
      url: link ? this.url : undefined,
    }) as APIButtonComponent;
  }
}

export abstract class Button extends BaseButton {}

export abstract class LinkButton extends BaseButton {
  customId = "";
  abstract url: string;
  override style = ButtonStyle.Link;
  override async run(): Promise<never> {
    throw new Error("Link buttons do not run handlers");
  }
}

export abstract class AnySelectMenu extends BaseMessageInteractiveComponent {
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  disabled = false;
  required?: boolean;
  defaultValues?: unknown[];
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

export abstract class MentionableSelectMenu extends AnySelectMenu {
  readonly type = ComponentType.MentionableSelect;
}

export abstract class ChannelSelectMenu extends AnySelectMenu {
  readonly type = ComponentType.ChannelSelect;
  channelTypes?: APIChannelSelectComponent["channel_types"];
  override serializeOptions() {
    return {
      type: this.type,
      default_values: this.defaultValues,
      channel_types: this.channelTypes,
    };
  }
}

export class Row<T extends BaseMessageInteractiveComponent> extends BaseComponent {
  readonly type = ComponentType.ActionRow;
  override readonly isV2 = false;
  constructor(public components: T[] = []) {
    super();
  }
  addComponent(component: T): void {
    this.components.push(component);
  }
  serialize(): APIActionRowComponent<APIComponentInMessageActionRow> {
    return {
      type: this.type,
      components: this.components.map(
        (entry) => entry.serialize() as APIComponentInMessageActionRow,
      ),
    };
  }
}

abstract class V2Component extends BaseComponent {
  override readonly isV2 = true;
}

export class TextDisplay extends V2Component {
  readonly type = ComponentType.TextDisplay;
  constructor(public content?: string) {
    super();
  }
  serialize(): APITextDisplayComponent {
    return clean({ type: this.type, content: this.content }) as APITextDisplayComponent;
  }
}

export class Separator extends V2Component {
  readonly type = ComponentType.Separator;
  divider = true;
  spacing: 1 | 2 | "small" | "large" = "small";
  constructor(options?: { spacing?: Separator["spacing"]; divider?: boolean }) {
    super();
    this.spacing = options?.spacing ?? this.spacing;
    this.divider = options?.divider ?? this.divider;
  }
  serialize(): APISeparatorComponent {
    return clean({
      type: this.type,
      divider: this.divider,
      spacing: this.spacing === "large" ? 2 : this.spacing === "small" ? 1 : this.spacing,
    }) as APISeparatorComponent;
  }
}

export class Thumbnail extends V2Component {
  readonly type = ComponentType.Thumbnail;
  constructor(public url?: string) {
    super();
  }
  serialize(): APIThumbnailComponent {
    return clean({
      type: this.type,
      media: this.url ? { url: this.url } : undefined,
    }) as APIThumbnailComponent;
  }
}

export class Section extends V2Component {
  readonly type = ComponentType.Section;
  constructor(
    public components: TextDisplay[] = [],
    public accessory?: Thumbnail | Button | LinkButton,
  ) {
    super();
  }
  serialize(): APISectionComponent {
    return clean({
      type: this.type,
      components: this.components.map((entry) => entry.serialize()),
      accessory: this.accessory?.serialize(),
    }) as APISectionComponent;
  }
}

export class MediaGallery extends V2Component {
  readonly type = ComponentType.MediaGallery;
  constructor(public items: Array<{ url: string; description?: string; spoiler?: boolean }> = []) {
    super();
  }
  serialize(): APIMediaGalleryComponent {
    return {
      type: this.type,
      items: this.items.map((entry) => ({
        media: { url: entry.url },
        description: entry.description,
        spoiler: entry.spoiler,
      })),
    };
  }
}

export class File extends V2Component {
  readonly type = ComponentType.File;
  constructor(
    public file?: `attachment://${string}`,
    public spoiler = false,
  ) {
    super();
  }
  serialize(): APIFileComponent {
    return clean({
      type: this.type,
      file: this.file ? { url: this.file } : undefined,
      spoiler: this.spoiler || undefined,
    }) as APIFileComponent;
  }
}

export class Container extends V2Component {
  readonly type = ComponentType.Container;
  accentColor?: string | number;
  spoiler = false;
  constructor(
    public components: Array<
      Row<BaseMessageInteractiveComponent> | TextDisplay | Section | MediaGallery | Separator | File
    > = [],
    options?: { accentColor?: string | number; spoiler?: boolean },
  ) {
    super();
    this.accentColor = options?.accentColor;
    this.spoiler = options?.spoiler ?? false;
  }
  serialize(): APIContainerComponent {
    return clean({
      type: this.type,
      components: this.components.map((entry) => entry.serialize()),
      accent_color: colorToNumber(this.accentColor),
      spoiler: this.spoiler || undefined,
    }) as APIContainerComponent;
  }
}
