//#region src/shared/record-coerce.d.ts
declare function asRecord(value: unknown): Record<string, unknown>;
declare function readStringField(record: Record<string, unknown> | null | undefined, key: string): string | undefined;
declare function asOptionalRecord(value: unknown): Record<string, unknown> | undefined;
declare function asNullableRecord(value: unknown): Record<string, unknown> | null;
declare function asOptionalObjectRecord(value: unknown): Record<string, unknown> | undefined;
declare function asNullableObjectRecord(value: unknown): Record<string, unknown> | null;
//#endregion
//#region src/shared/string-sample.d.ts
declare function summarizeStringEntries(params: {
  entries?: ReadonlyArray<string> | null;
  limit?: number;
  emptyText?: string;
}): string;
//#endregion
export { asOptionalRecord as a, asOptionalObjectRecord as i, asNullableObjectRecord as n, asRecord as o, asNullableRecord as r, readStringField as s, summarizeStringEntries as t };