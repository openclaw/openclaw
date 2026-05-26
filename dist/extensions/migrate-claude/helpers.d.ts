import { l as MigrationItem } from "../../types-Vx7Jq4_-2.js";
//#region extensions/migrate-claude/helpers.d.ts
declare function resolveHomePath(input: string): string;
declare function exists(filePath: string): Promise<boolean>;
declare function isDirectory(dirPath: string): Promise<boolean>;
declare function sanitizeName(name: string): string;
declare function readText(filePath: string | undefined): Promise<string | undefined>;
declare function readJsonObject(filePath: string | undefined): Promise<Record<string, unknown>>;
declare function isRecord(value: unknown): value is Record<string, unknown>;
declare function childRecord(root: Record<string, unknown> | undefined, key: string): Record<string, unknown>;
declare function appendItem(item: MigrationItem): Promise<MigrationItem>;
//#endregion
export { appendItem, childRecord, exists, isDirectory, isRecord, readJsonObject, readText, resolveHomePath, sanitizeName };