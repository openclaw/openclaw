export declare const ACT_KINDS: readonly ["click", "close", "drag", "evaluate", "fill", "hover", "scrollIntoView", "press", "resize", "select", "type", "wait"];
export type ActKind = (typeof ACT_KINDS)[number];
export declare function isActKind(value: unknown): value is ActKind;
export type ClickButton = "left" | "right" | "middle";
export type ClickModifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";
export declare function parseClickButton(raw: string): ClickButton | undefined;
export declare function parseClickModifiers(raw: string[]): {
    modifiers?: ClickModifier[];
    error?: string;
};
