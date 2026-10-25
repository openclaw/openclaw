/**
 * @typedef {import("./node-sqlite-capabilities.d.mts").SqliteCapabilities} SqliteCapabilities
 * @typedef {import("./node-sqlite-capabilities.d.mts").SqliteCapabilityDatabase} SqliteCapabilityDatabase
 * @typedef {import("./node-sqlite-capabilities.d.mts").SqliteCapabilityDatabaseConstructor} SqliteCapabilityDatabaseConstructor
 */

/**
 * @param {SqliteCapabilityDatabaseConstructor} DatabaseSync
 * @returns {SqliteCapabilities}
 */
export function probeSqlite(DatabaseSync) {
  /** @type {SqliteCapabilities} */
  const result = { available: false, version: null, text: false, blob: false, json: false };
  /** @type {SqliteCapabilityDatabase | undefined} */
  let database;
  try {
    database = new DatabaseSync(":memory:");
    result.available = true;
    const version = database.prepare("SELECT sqlite_version() AS version").get()?.version;
    result.version = typeof version === "string" ? version : null;
    const text = "a\u0000b\u0000";
    const bytes = Buffer.from(text, "utf8");
    const json = JSON.stringify({ value: text });
    database.exec("CREATE TABLE probe (text_value TEXT, blob_value BLOB, json_value TEXT)");
    database.prepare("INSERT INTO probe VALUES (?, ?, ?)").run(text, bytes, json);
    const row = database.prepare("SELECT text_value, blob_value, json_value FROM probe").get();
    result.text =
      typeof row?.text_value === "string" &&
      row.text_value.length === text.length &&
      Buffer.from(row.text_value, "utf8").equals(bytes);
    result.blob =
      row?.blob_value instanceof Uint8Array && Buffer.from(row.blob_value).equals(bytes);
    result.json = row?.json_value === json && JSON.parse(row.json_value).value === text;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    database?.close();
  }
  return result;
}

/** @param {string} value */
export function isSqliteWalResetSafeVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value.trim());
  if (!match) {
    return false;
  }
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return false;
  }
  return (
    major > 3 ||
    (major === 3 &&
      (minor > 51 ||
        (minor === 51 && patch >= 3) ||
        (minor === 50 && patch >= 7) ||
        (minor === 44 && patch >= 6)))
  );
}
