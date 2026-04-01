/**
 * File-based audit logger implementation.
 *
 * Provides persistent audit logging with in-memory buffering for performance.
 *
 * Features:
 * - Asynchronous writes (non-blocking)
 * - Automatic flush on buffer full or timer
 * - JSONL format (one JSON per line)
 * - Daily rotation
 * - Automatic log pruning
 *
 * TODO: Add gzip compression for old log files (disk space optimization)
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { logVerbose } from "../../../globals.js";
import type {
  AuditLogEntry,
  AuditLogFilters,
  AuditLogStats,
  AuditLoggerConfig,
  IAuditLogger,
} from "./audit.types.js";
import { DEFAULT_AUDIT_CONFIG } from "./audit.types.js";

/**
 * File-based audit logger.
 */
export class FileAuditLogger implements IAuditLogger {
  private buffer: AuditLogEntry[] = [];
  private flushTimer?: NodeJS.Timeout;
  private isClosed = false;
  private stats = {
    totalEntries: 0,
    entriesByAction: {} as Record<string, number>,
    entriesByResult: { success: 0, failure: 0 },
    oldestEntry: undefined as number | undefined,
    newestEntry: undefined as number | undefined,
  };

  constructor(private readonly config: AuditLoggerConfig = {}) {
    this.config = { ...DEFAULT_AUDIT_CONFIG, ...config };

    // Start flush timer
    if (this.config.flushInterval && this.config.flushInterval > 0) {
      this.flushTimer = setInterval(() => {
        this.flush().catch((err) => {
          if (!this.isClosed) {
            logVerbose(`audit: periodic flush failed: ${err}`);
          }
        });
      }, this.config.flushInterval);
      this.flushTimer.unref();
    }

    // Ensure storage directory exists
    if (this.config.enabled && this.config.storageDir) {
      fs.mkdir(this.config.storageDir, { recursive: true }).catch((err) => {
        logVerbose(`audit: failed to create storage dir: ${err}`);
      });
    }
  }

  /**
   * Log an audit event.
   */
  async log(entry: Omit<AuditLogEntry, "id" | "timestamp">): Promise<void> {
    if (!this.config.enabled || this.isClosed) {
      return;
    }

    const enriched: AuditLogEntry = {
      id: randomUUID(),
      timestamp: Date.now(),
      ...entry,
    };

    // Update stats
    this.stats.totalEntries++;
    this.stats.entriesByAction[entry.action] = (this.stats.entriesByAction[entry.action] ?? 0) + 1;
    if (entry.result === "success") {
      this.stats.entriesByResult.success++;
    } else {
      this.stats.entriesByResult.failure++;
    }
    if (!this.stats.oldestEntry || enriched.timestamp < this.stats.oldestEntry) {
      this.stats.oldestEntry = enriched.timestamp;
    }
    if (!this.stats.newestEntry || enriched.timestamp > this.stats.newestEntry) {
      this.stats.newestEntry = enriched.timestamp;
    }

    // Add to buffer
    this.buffer.push(enriched);

    // Auto-flush if buffer is full
    if (this.config.maxBufferSize && this.buffer.length >= this.config.maxBufferSize) {
      // Flush asynchronously without blocking
      setImmediate(() => {
        this.flush().catch((err) => {
          if (!this.isClosed) {
            logVerbose(`audit: auto-flush failed: ${err}`);
          }
        });
      });
    }
  }

  /**
   * Query audit logs.
   */
  async query(filters: AuditLogFilters): Promise<AuditLogEntry[]> {
    if (!this.config.enabled) {
      return [];
    }

    const results: AuditLogEntry[] = [];

    // Include buffered entries (most recent)
    for (const entry of this.buffer) {
      // Apply filters
      if (filters.startTime && entry.timestamp < filters.startTime) {
        continue;
      }
      if (filters.endTime && entry.timestamp > filters.endTime) {
        continue;
      }
      if (filters.userId && entry.actor.userId !== filters.userId) {
        continue;
      }
      if (filters.deviceId && entry.actor.deviceId !== filters.deviceId) {
        continue;
      }
      if (filters.sessionKey && entry.sessionKey !== filters.sessionKey) {
        continue;
      }
      if (filters.agentId && entry.agentId !== filters.agentId) {
        continue;
      }
      if (filters.action && entry.action !== filters.action) {
        continue;
      }
      if (filters.result && entry.result !== filters.result) {
        continue;
      }

      results.push(entry);

      // Apply limit
      if (filters.limit && results.length >= filters.limit) {
        return results;
      }
    }

    try {
      // Get all log files
      const files = await fs.readdir(this.config.storageDir!);
      const logFiles = files.filter((f) => f.endsWith(".jsonl"));

      // Read and filter each file
      for (const file of logFiles) {
        const filePath = join(this.config.storageDir!, file);
        const content = await fs.readFile(filePath, "utf-8");
        const lines = content.split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            const entry: AuditLogEntry = JSON.parse(line);

            // Apply filters
            if (filters.startTime && entry.timestamp < filters.startTime) {
              continue;
            }
            if (filters.endTime && entry.timestamp > filters.endTime) {
              continue;
            }
            if (filters.userId && entry.actor.userId !== filters.userId) {
              continue;
            }
            if (filters.deviceId && entry.actor.deviceId !== filters.deviceId) {
              continue;
            }
            if (filters.sessionKey && entry.sessionKey !== filters.sessionKey) {
              continue;
            }
            if (filters.agentId && entry.agentId !== filters.agentId) {
              continue;
            }
            if (filters.action && entry.action !== filters.action) {
              continue;
            }
            if (filters.result && entry.result !== filters.result) {
              continue;
            }

            results.push(entry);

            // Apply limit
            if (filters.limit && results.length >= filters.limit) {
              return results;
            }
          } catch (err) {
            logVerbose(`audit: failed to parse log line: ${String(err)}`);
          }
        }
      }
    } catch (err) {
      logVerbose(`audit: query failed: ${String(err)}`);
    }

    return results;
  }

  /**
   * Flush buffered logs to disk.
   */
  async flush(): Promise<void> {
    if (!this.config.enabled || this.buffer.length === 0) {
      return;
    }

    const toFlush = this.buffer.splice(0);

    if (toFlush.length === 0) {
      return;
    }

    try {
      // Generate filename for today
      const date = new Date().toISOString().split("T")[0];
      const filePath = join(this.config.storageDir!, `audit-${date}.jsonl`);

      // Serialize and append
      const lines = toFlush.map((entry) => JSON.stringify(entry)).join("\n") + "\n";

      await fs.appendFile(filePath, lines, "utf-8");

      logVerbose(`audit: flushed ${toFlush.length} entries to ${filePath}`);
    } catch (err) {
      // Put entries back in buffer if flush failed
      this.buffer.unshift(...toFlush);
      logVerbose(`audit: flush failed: ${String(err)}`);
      throw err;
    }
  }

  /**
   * Get audit log statistics.
   */
  async getStats(): Promise<AuditLogStats> {
    return {
      totalEntries: this.stats.totalEntries,
      entriesByAction: { ...this.stats.entriesByAction },
      entriesByResult: { ...this.stats.entriesByResult },
      oldestEntry: this.stats.oldestEntry,
      newestEntry: this.stats.newestEntry,
    };
  }

  /**
   * Prune old log entries.
   */
  async prune(before: number): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    let pruned = 0;

    try {
      const files = await fs.readdir(this.config.storageDir!);
      const logFiles = files.filter((f) => f.endsWith(".jsonl"));

      for (const file of logFiles) {
        const filePath = join(this.config.storageDir!, file);

        // Parse date from filename
        const match = file.match(/audit-(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (!match) {
          continue;
        }

        const fileDate = new Date(match[1]);
        if (fileDate.getTime() < before) {
          await fs.unlink(filePath);
          pruned++;
          logVerbose(`audit: pruned ${filePath}`);
        }
      }
    } catch (err) {
      logVerbose(`audit: prune failed: ${String(err)}`);
    }

    return pruned;
  }

  /**
   * Close the audit logger and flush remaining logs.
   */
  async close(): Promise<void> {
    this.isClosed = true;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    await this.flush();
    logVerbose("audit: closed");
  }
}
