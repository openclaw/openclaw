import { executeQuery } from "./mysql-client.js";
import type { FeedRow, MySqlConfig, FeedRecord } from "./types.js";

/**
 * Get visible field names for a given topicId from feed_result_field.
 */
export async function getVisibleFields(
  config: MySqlConfig,
  topicId: number,
): Promise<string[]> {
  try {
    const rows = await executeQuery<Array<{ name: string }>>(
      config,
      "SELECT DISTINCT name FROM feed_result_field WHERE topicId = ? AND visible = 1",
      [topicId],
    );
    return rows.map((r) => String(r.name));
  } catch {
    return [];
  }
}

/**
 * Parse the result JSON string and keep only keys present in visibleFields.
 * If visibleFields is empty, return all keys.
 */
export function filterResultByVisibleFields(
  resultJson: string | null,
  visibleFields: string[],
): Record<string, unknown> {
  if (!resultJson) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return { raw: resultJson };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { raw: resultJson };
  }

  const obj = parsed as Record<string, unknown>;

  if (visibleFields.length === 0) {
    return obj;
  }

  const visibleSet = new Set(visibleFields);
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (visibleSet.has(k)) {
      filtered[k] = v;
    }
  }
  return filtered;
}

/**
 * Map a database row tuple to a FeedRecord, filtering result JSON by visible fields.
 */
export function mapRowToRecord(row: FeedRow, visibleFields: string[]): FeedRecord {
  return {
    id: row[0],
    author: row[1],
    reporter: row[2],
    title: row[3],
    titleClean: row[4],
    content: row[5],
    label: row[6],
    keywords: row[7],
    keySentences: row[8],
    summary: row[9],
    result: filterResultByVisibleFields(row[10], visibleFields),
    eventDate: row[11] ? String(row[11]) : null,
  };
}
