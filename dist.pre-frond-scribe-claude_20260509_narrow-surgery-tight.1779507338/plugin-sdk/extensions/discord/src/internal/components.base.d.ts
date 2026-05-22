import type { BaseComponentInteraction } from "./interactions.js";
export type ComponentParserResult = {
    key: string;
    data: Record<string, string | boolean>;
};
export type ComponentData<T extends keyof ComponentParserResult["data"] = keyof ComponentParserResult["data"]> = {
    [K in T]: ComponentParserResult["data"][K];
};
export type ConditionalComponentOption = (interaction: BaseComponentInteraction) => boolean;
export declare function parseCustomId(id: string): ComponentParserResult;
export declare function clean<T extends Record<string, unknown>>(value: T): T;
export declare function colorToNumber(value: string | number | undefined): number | undefined;
export declare abstract class BaseComponent {
    abstract readonly type: number;
    readonly isV2: boolean;
    abstract serialize(): unknown;
}
export declare abstract class BaseMessageInteractiveComponent extends BaseComponent {
    readonly isV2 = false;
    defer: boolean | ConditionalComponentOption;
    ephemeral: boolean | ConditionalComponentOption;
    abstract customId: string;
    customIdParser: typeof parseCustomId;
    run(_interaction: BaseComponentInteraction, _data: ComponentData): unknown;
}
export declare abstract class BaseModalComponent extends BaseComponent {
    abstract customId: string;
}
