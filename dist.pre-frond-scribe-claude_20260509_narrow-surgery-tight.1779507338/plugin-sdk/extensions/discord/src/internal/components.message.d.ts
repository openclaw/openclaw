import { ButtonStyle, ComponentType, type APIActionRowComponent, type APIButtonComponent, type APIChannelSelectComponent, type APIComponentInMessageActionRow, type APIContainerComponent, type APIFileComponent, type APIMediaGalleryComponent, type APISectionComponent, type APISeparatorComponent, type APIStringSelectComponent, type APITextDisplayComponent, type APIThumbnailComponent } from "discord-api-types/v10";
import { BaseComponent, BaseMessageInteractiveComponent } from "./components.base.js";
declare abstract class BaseButton extends BaseMessageInteractiveComponent {
    readonly type = ComponentType.Button;
    abstract label: string;
    emoji?: {
        name: string;
        id?: string;
        animated?: boolean;
    };
    style: ButtonStyle;
    disabled: boolean;
}
export declare abstract class Button extends BaseButton {
    serialize(): APIButtonComponent;
}
export declare abstract class LinkButton extends BaseButton {
    customId: string;
    abstract url: string;
    style: ButtonStyle;
    run(): Promise<never>;
    serialize(): APIButtonComponent;
}
export declare abstract class AnySelectMenu extends BaseMessageInteractiveComponent {
    placeholder?: string;
    minValues?: number;
    maxValues?: number;
    disabled: boolean;
    required?: boolean;
    abstract serializeOptions(): Record<string, unknown>;
    serialize(): {
        custom_id: string;
        placeholder: string | undefined;
        min_values: number | undefined;
        max_values: number | undefined;
        disabled: true | undefined;
        required: boolean | undefined;
    };
}
export declare abstract class StringSelectMenu extends AnySelectMenu {
    readonly type = ComponentType.StringSelect;
    abstract options: APIStringSelectComponent["options"];
    serializeOptions(): {
        type: ComponentType;
        options: import("discord-api-types/v10").APISelectMenuOption[];
    };
}
export declare abstract class UserSelectMenu extends AnySelectMenu {
    readonly type = ComponentType.UserSelect;
    defaultValues?: unknown[];
    serializeOptions(): {
        type: ComponentType;
        default_values: unknown[] | undefined;
    };
}
export declare abstract class RoleSelectMenu extends AnySelectMenu {
    readonly type = ComponentType.RoleSelect;
    defaultValues?: unknown[];
    serializeOptions(): {
        type: ComponentType;
        default_values: unknown[] | undefined;
    };
}
export declare abstract class MentionableSelectMenu extends AnySelectMenu {
    readonly type = ComponentType.MentionableSelect;
    defaultValues?: unknown[];
    serializeOptions(): {
        type: ComponentType;
        default_values: unknown[] | undefined;
    };
}
export declare abstract class ChannelSelectMenu extends AnySelectMenu {
    readonly type = ComponentType.ChannelSelect;
    channelTypes?: APIChannelSelectComponent["channel_types"];
    defaultValues?: unknown[];
    serializeOptions(): {
        type: ComponentType;
        default_values: unknown[] | undefined;
        channel_types: import("discord-api-types/v10").ChannelType[] | undefined;
    };
}
export declare class Row<T extends BaseMessageInteractiveComponent> extends BaseComponent {
    readonly type = ComponentType.ActionRow;
    readonly isV2 = false;
    components: T[];
    constructor(components?: T[]);
    addComponent(component: T): void;
    removeComponent(component: T): void;
    removeAllComponents(): void;
    serialize(): APIActionRowComponent<APIComponentInMessageActionRow>;
}
export declare class TextDisplay extends BaseComponent {
    content?: string | undefined;
    readonly type = ComponentType.TextDisplay;
    readonly isV2 = true;
    constructor(content?: string | undefined);
    serialize(): APITextDisplayComponent;
}
export declare class Separator extends BaseComponent {
    readonly type = ComponentType.Separator;
    readonly isV2 = true;
    divider: boolean;
    spacing: 1 | 2 | "small" | "large";
    constructor(options?: {
        spacing?: Separator["spacing"];
        divider?: boolean;
    });
    serialize(): APISeparatorComponent;
}
export declare class Thumbnail extends BaseComponent {
    url?: string | undefined;
    readonly type = ComponentType.Thumbnail;
    readonly isV2 = true;
    constructor(url?: string | undefined);
    serialize(): APIThumbnailComponent;
}
export declare class Section extends BaseComponent {
    components: TextDisplay[];
    accessory?: (Thumbnail | Button | LinkButton) | undefined;
    readonly type = ComponentType.Section;
    readonly isV2 = true;
    constructor(components?: TextDisplay[], accessory?: (Thumbnail | Button | LinkButton) | undefined);
    serialize(): APISectionComponent;
}
export declare class MediaGallery extends BaseComponent {
    items: Array<{
        url: string;
        description?: string;
        spoiler?: boolean;
    }>;
    readonly type = ComponentType.MediaGallery;
    readonly isV2 = true;
    constructor(items?: Array<{
        url: string;
        description?: string;
        spoiler?: boolean;
    }>);
    serialize(): APIMediaGalleryComponent;
}
export declare class File extends BaseComponent {
    file?: `attachment://${string}` | undefined;
    spoiler: boolean;
    readonly type = ComponentType.File;
    readonly isV2 = true;
    constructor(file?: `attachment://${string}` | undefined, spoiler?: boolean);
    serialize(): APIFileComponent;
}
export declare class Container extends BaseComponent {
    readonly type = ComponentType.Container;
    readonly isV2 = true;
    components: Array<Row<BaseMessageInteractiveComponent> | TextDisplay | Section | MediaGallery | Separator | File>;
    accentColor?: string | number;
    spoiler: boolean;
    constructor(components?: Container["components"], options?: {
        accentColor?: string | number;
        spoiler?: boolean;
    });
    serialize(): APIContainerComponent;
}
export {};
