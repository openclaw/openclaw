import { Label, Modal, TextDisplay, type ComponentParserResult, type TopLevelComponents } from "@buape/carbon";
export declare const DISCORD_COMPONENT_CUSTOM_ID_KEY = "occomp";
export declare const DISCORD_MODAL_CUSTOM_ID_KEY = "ocmodal";
export declare const DISCORD_COMPONENT_ATTACHMENT_PREFIX = "attachment://";
export type DiscordComponentButtonStyle = "primary" | "secondary" | "success" | "danger" | "link";
export type DiscordComponentSelectType = "string" | "user" | "role" | "mentionable" | "channel";
export type DiscordComponentModalFieldType = "text" | "checkbox" | "radio" | "select" | "role-select" | "user-select";
export type DiscordComponentButtonSpec = {
    label: string;
    style?: DiscordComponentButtonStyle;
    url?: string;
    emoji?: {
        name: string;
        id?: string;
        animated?: boolean;
    };
    disabled?: boolean;
    /** Optional allowlist of users who can interact with this button (ids or names). */
    allowedUsers?: string[];
};
export type DiscordComponentSelectOption = {
    label: string;
    value: string;
    description?: string;
    emoji?: {
        name: string;
        id?: string;
        animated?: boolean;
    };
    default?: boolean;
};
export type DiscordComponentSelectSpec = {
    type?: DiscordComponentSelectType;
    placeholder?: string;
    minValues?: number;
    maxValues?: number;
    options?: DiscordComponentSelectOption[];
};
export type DiscordComponentSectionAccessory = {
    type: "thumbnail";
    url: string;
} | {
    type: "button";
    button: DiscordComponentButtonSpec;
};
type DiscordComponentSeparatorSpacing = "small" | "large" | 1 | 2;
export type DiscordComponentBlock = {
    type: "text";
    text: string;
} | {
    type: "section";
    text?: string;
    texts?: string[];
    accessory?: DiscordComponentSectionAccessory;
} | {
    type: "separator";
    spacing?: DiscordComponentSeparatorSpacing;
    divider?: boolean;
} | {
    type: "actions";
    buttons?: DiscordComponentButtonSpec[];
    select?: DiscordComponentSelectSpec;
} | {
    type: "media-gallery";
    items: Array<{
        url: string;
        description?: string;
        spoiler?: boolean;
    }>;
} | {
    type: "file";
    file: `attachment://${string}`;
    spoiler?: boolean;
};
export type DiscordModalFieldSpec = {
    type: DiscordComponentModalFieldType;
    name?: string;
    label: string;
    description?: string;
    placeholder?: string;
    required?: boolean;
    options?: DiscordComponentSelectOption[];
    minValues?: number;
    maxValues?: number;
    minLength?: number;
    maxLength?: number;
    style?: "short" | "paragraph";
};
export type DiscordModalSpec = {
    title: string;
    triggerLabel?: string;
    triggerStyle?: DiscordComponentButtonStyle;
    fields: DiscordModalFieldSpec[];
};
export type DiscordComponentMessageSpec = {
    text?: string;
    reusable?: boolean;
    container?: {
        accentColor?: string | number;
        spoiler?: boolean;
    };
    blocks?: DiscordComponentBlock[];
    modal?: DiscordModalSpec;
};
export type DiscordComponentEntry = {
    id: string;
    kind: "button" | "select" | "modal-trigger";
    label: string;
    selectType?: DiscordComponentSelectType;
    options?: Array<{
        value: string;
        label: string;
    }>;
    modalId?: string;
    sessionKey?: string;
    agentId?: string;
    accountId?: string;
    reusable?: boolean;
    allowedUsers?: string[];
    messageId?: string;
    createdAt?: number;
    expiresAt?: number;
};
export type DiscordModalFieldDefinition = {
    id: string;
    name: string;
    label: string;
    type: DiscordComponentModalFieldType;
    description?: string;
    placeholder?: string;
    required?: boolean;
    options?: DiscordComponentSelectOption[];
    minValues?: number;
    maxValues?: number;
    minLength?: number;
    maxLength?: number;
    style?: "short" | "paragraph";
};
export type DiscordModalEntry = {
    id: string;
    title: string;
    fields: DiscordModalFieldDefinition[];
    sessionKey?: string;
    agentId?: string;
    accountId?: string;
    reusable?: boolean;
    messageId?: string;
    createdAt?: number;
    expiresAt?: number;
};
export type DiscordComponentBuildResult = {
    components: TopLevelComponents[];
    entries: DiscordComponentEntry[];
    modals: DiscordModalEntry[];
};
export declare function resolveDiscordComponentAttachmentName(value: string): string;
export declare function readDiscordComponentSpec(raw: unknown): DiscordComponentMessageSpec | null;
export declare function buildDiscordComponentCustomId(params: {
    componentId: string;
    modalId?: string;
}): string;
export declare function buildDiscordModalCustomId(modalId: string): string;
export declare function parseDiscordComponentCustomId(id: string): {
    componentId: string;
    modalId?: string;
} | null;
export declare function parseDiscordModalCustomId(id: string): string | null;
export declare function parseDiscordComponentCustomIdForCarbon(id: string): ComponentParserResult;
export declare function parseDiscordModalCustomIdForCarbon(id: string): ComponentParserResult;
export declare function buildDiscordComponentMessage(params: {
    spec: DiscordComponentMessageSpec;
    fallbackText?: string;
    sessionKey?: string;
    agentId?: string;
    accountId?: string;
}): DiscordComponentBuildResult;
export declare function buildDiscordComponentMessageFlags(components: TopLevelComponents[]): number | undefined;
export declare class DiscordFormModal extends Modal {
    title: string;
    customId: string;
    components: Array<Label | TextDisplay>;
    customIdParser: typeof parseDiscordModalCustomIdForCarbon;
    constructor(params: {
        modalId: string;
        title: string;
        fields: DiscordModalFieldDefinition[];
    });
    run(): Promise<void>;
}
export declare function createDiscordFormModal(entry: DiscordModalEntry): Modal;
export declare function formatDiscordComponentEventText(params: {
    kind: "button" | "select";
    label: string;
    values?: string[];
}): string;
export {};
