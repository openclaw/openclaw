import type { BrowserFormField } from "./client-actions-core.js";
export declare const DEFAULT_FILL_FIELD_TYPE = "text";
type BrowserFormFieldValue = NonNullable<BrowserFormField["value"]>;
export declare function normalizeBrowserFormFieldRef(value: unknown): string;
export declare function normalizeBrowserFormFieldType(value: unknown): string;
export declare function normalizeBrowserFormFieldValue(value: unknown): BrowserFormFieldValue | undefined;
export declare function normalizeBrowserFormField(record: Record<string, unknown>): BrowserFormField | null;
export {};
