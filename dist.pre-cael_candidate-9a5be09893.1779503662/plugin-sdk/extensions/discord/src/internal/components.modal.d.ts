import { ComponentType, TextInputStyle, type APITextInputComponent } from "discord-api-types/v10";
import { BaseModalComponent, parseCustomId, type ComponentData } from "./components.base.js";
import { AnySelectMenu, TextDisplay } from "./components.message.js";
export declare abstract class TextInput extends BaseModalComponent {
    readonly type = ComponentType.TextInput;
    customIdParser: typeof parseCustomId;
    style: TextInputStyle;
    minLength?: number;
    maxLength?: number;
    required?: boolean;
    value?: string;
    placeholder?: string;
    serialize(): APITextInputComponent;
}
export declare abstract class CheckboxGroup extends BaseModalComponent {
    readonly type = 22;
    options: Array<{
        value: string;
        label: string;
        description?: string;
        default?: boolean;
    }>;
    required?: boolean;
    minValues?: number;
    maxValues?: number;
    serialize(): {
        type: number;
        custom_id: string;
        options: {
            value: string;
            label: string;
            description?: string;
            default?: boolean;
        }[];
        required: boolean | undefined;
        min_values: number | undefined;
        max_values: number | undefined;
    };
}
export declare abstract class RadioGroup extends BaseModalComponent {
    readonly type = 21;
    options: Array<{
        value: string;
        label: string;
        description?: string;
        default?: boolean;
    }>;
    required?: boolean;
    minValues?: number;
    maxValues?: number;
    serialize(): {
        type: number;
        custom_id: string;
        options: {
            value: string;
            label: string;
            description?: string;
            default?: boolean;
        }[];
        required: boolean | undefined;
        min_values: number | undefined;
        max_values: number | undefined;
    };
}
export declare abstract class Label extends BaseModalComponent {
    component?: (TextInput | AnySelectMenu | CheckboxGroup | RadioGroup) | undefined;
    readonly type = ComponentType.Label;
    abstract label: string;
    description?: string;
    customId: string;
    constructor(component?: (TextInput | AnySelectMenu | CheckboxGroup | RadioGroup) | undefined);
    serialize(): {
        type: ComponentType;
        label: string;
        description: string | undefined;
        component: APITextInputComponent | {
            custom_id: string;
            placeholder: string | undefined;
            min_values: number | undefined;
            max_values: number | undefined;
            disabled: true | undefined;
            required: boolean | undefined;
        } | {
            type: number;
            custom_id: string;
            options: {
                value: string;
                label: string;
                description?: string;
                default?: boolean;
            }[];
            required: boolean | undefined;
            min_values: number | undefined;
            max_values: number | undefined;
        } | undefined;
    };
}
export declare abstract class Modal {
    abstract title: string;
    components: Array<Label | TextDisplay>;
    abstract customId: string;
    customIdParser: typeof parseCustomId;
    abstract run(interaction: unknown, data: ComponentData): unknown;
    serialize(): {
        title: string;
        custom_id: string;
        components: (import("discord-api-types/v10").APITextDisplayComponent | {
            type: ComponentType;
            label: string;
            description: string | undefined;
            component: APITextInputComponent | {
                custom_id: string;
                placeholder: string | undefined;
                min_values: number | undefined;
                max_values: number | undefined;
                disabled: true | undefined;
                required: boolean | undefined;
            } | {
                type: number;
                custom_id: string;
                options: {
                    value: string;
                    label: string;
                    description?: string;
                    default?: boolean;
                }[];
                required: boolean | undefined;
                min_values: number | undefined;
                max_values: number | undefined;
            } | undefined;
        })[];
    };
}
