/**
 * TypeDB HTTP Client — Singleton wrapper with graceful degradation
 *
 * Provides a thin abstraction over the typedb-driver-http package.
 * When TypeDB is unavailable, all methods throw TypeDBUnavailableError
 * so callers can fall back to file-based storage.
 */

import type {
  TypeDBHttpDriver as TypeDBHttpDriverType,
  DriverParams,
  ApiResponse,
  QueryResponse,
  DatabasesListResponse,
  Database,
} from "typedb-driver-http";

// ── Error Types ─────────────────────────────────────────────────────────

export class TypeDBUnavailableError extends Error {
  constructor(message = "TypeDB is not available") {
    super(message);
    this.name = "TypeDBUnavailableError";
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function unwrap<T>(res: ApiResponse<T>): T {
  if ("err" in res) {
    throw new Error(`TypeDB API error [${res.err.code}]: ${res.err.message}`);
  }
  return (res as { ok: T }).ok;
}

// ── Client ──────────────────────────────────────────────────────────────

export class TypeDBClient {
  private driver: TypeDBHttpDriverType | null = null;
  private available = false;
  private driverParams: DriverParams;
  private currentDatabase: string | null = null;

  constructor(params?: Partial<DriverParams> & { addresses?: string[] }) {
    this.driverParams = {
      username: params?.username ?? "admin",
      password: params?.password ?? "password",
      addresses: params?.addresses ?? [process.env.TYPEDB_URL || "http://157.230.13.13:8729"],
    };
  }

  /** Attempt to connect to TypeDB. Sets available flag silently. */
  async connect(): Promise<boolean> {
    try {
      const { TypeDBHttpDriver } = await import("typedb-driver-http");
      this.driver = new TypeDBHttpDriver(this.driverParams);
      // Verify connectivity by listing databases
      const res = await this.driver.getDatabases();
      unwrap(res);
      this.available = true;
      return true;
    } catch {
      this.driver = null;
      this.available = false;
      return false;
    }
  }

  isAvailable(): boolean {
    return this.available && this.driver !== null;
  }

  private ensureAvailable(): void {
    if (!this.isAvailable()) {
      throw new TypeDBUnavailableError();
    }
  }

  /** Create database if it does not exist. */
  async ensureDatabase(name: string): Promise<void> {
    this.ensureAvailable();
    try {
      const listRes = await this.driver!.getDatabases();
      const { databases } = unwrap(listRes) as DatabasesListResponse;
      const exists = databases.some((db: Database) => db.name === name);
      if (!exists) {
        const createRes = await this.driver!.createDatabase(name);
        unwrap(createRes);
      }
      this.currentDatabase = name;
    } catch (err) {
      this.available = false;
      throw new TypeDBUnavailableError(
        `Failed to ensure database "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Run a schema (define) transaction using one-shot query. */
  async defineSchema(typeql: string, database?: string): Promise<void> {
    this.ensureAvailable();
    const db = database || this.currentDatabase;
    if (!db) throw new Error("No database selected. Call ensureDatabase() first.");

    const res = await this.driver!.oneShotQuery(typeql, true, db, "schema");
    unwrap(res);
  }

  /** Insert data using one-shot write query. */
  async insertData(typeql: string, database?: string): Promise<QueryResponse | null> {
    this.ensureAvailable();
    const db = database || this.currentDatabase;
    if (!db) throw new Error("No database selected. Call ensureDatabase() first.");

    const res = await this.driver!.oneShotQuery(typeql, true, db, "write");
    return unwrap(res) as QueryResponse;
  }

  /** Run a match query using one-shot read query. */
  async matchQuery(typeql: string, database?: string): Promise<QueryResponse | null> {
    this.ensureAvailable();
    const db = database || this.currentDatabase;
    if (!db) throw new Error("No database selected. Call ensureDatabase() first.");

    const res = await this.driver!.oneShotQuery(typeql, false, db, "read");
    return unwrap(res) as QueryResponse;
  }

  /** Delete data using one-shot write query. */
  async deleteData(typeql: string, database?: string): Promise<void> {
    this.ensureAvailable();
    const db = database || this.currentDatabase;
    if (!db) throw new Error("No database selected. Call ensureDatabase() first.");

    const res = await this.driver!.oneShotQuery(typeql, true, db, "write");
    unwrap(res);
  }

  /** Ping server availability. */
  async healthCheck(): Promise<{ available: boolean; databases: string[] }> {
    try {
      if (!this.driver) {
        await this.connect();
      }
      if (!this.isAvailable()) {
        return { available: false, databases: [] };
      }
      const res = await this.driver!.getDatabases();
      const { databases } = unwrap(res) as DatabasesListResponse;
      return {
        available: true,
        databases: databases.map((db: Database) => db.name),
      };
    } catch {
      this.available = false;
      return { available: false, databases: [] };
    }
  }

  /** Close the driver connection (no-op for HTTP driver). */
  async close(): Promise<void> {
    this.driver = null;
    this.available = false;
  }
}

// ── Singleton ───────────────────────────────────────────────────────────

let clientInstance: TypeDBClient | null = null;

/**
 * Get the lazy singleton TypeDB client.
 * First call triggers connection attempt (non-blocking on failure).
 */
export function getTypeDBClient(serverUrl?: string): TypeDBClient {
  if (!clientInstance) {
    const addresses = serverUrl
      ? [serverUrl.startsWith("http") ? serverUrl : `http://${serverUrl}`]
      : undefined;
    clientInstance = new TypeDBClient(addresses ? { addresses } : undefined);
    // Fire-and-forget connection attempt
    clientInstance.connect().catch(() => {});
  }
  return clientInstance;
}
