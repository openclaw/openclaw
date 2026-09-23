import type { DatabaseSync } from "node:sqlite";

export function sqliteTranscriptPayloadColumns(database: DatabaseSync): string;
export function sqliteTranscriptPayloadBytesSql(database: DatabaseSync): string;
export function readSqliteTranscriptPayload(row: Record<string, unknown>): string;
