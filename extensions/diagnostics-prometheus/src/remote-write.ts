/**
 * Prometheus Remote Write client.
 *
 * Compatible with Prometheus remote_write configuration:
 *   https://prometheus.io/docs/prometheus/latest/configuration/configuration/#remote_write
 *
 * Supports:
 * - Remote Write 1.0 protocol (protobuf + snappy)
 * - basic_auth, bearer_token, custom headers
 * - TLS configuration (ca, cert, key, insecure_skip_verify)
 * - Queue configuration (capacity, max_samples_per_send, batch_send_deadline, max_retries)
 * - Exponential backoff with jitter on 5xx/429
 * - write_relabel_configs (label filtering)
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { encodeWriteRequest, type PromTimeSeries } from "./protobuf.js";

// ---- Configuration types (Prometheus-compatible) ----

export type BasicAuthConfig = {
  username?: string;
  password?: string;
  password_file?: string;
};

export type TlsConfig = {
  ca_file?: string;
  cert_file?: string;
  key_file?: string;
  server_name?: string;
  insecure_skip_verify?: boolean;
};

export type QueueConfig = {
  /** Per-shard capacity. Default: 2500 */
  capacity?: number;
  /** Maximum samples per send batch. Default: 500 */
  max_samples_per_send?: number;
  /** Maximum time to wait before sending a batch. Default: 5000 ms */
  batch_send_deadline_ms?: number;
  /** Maximum number of retries on 5xx/429. Default: 3 */
  max_retries?: number;
  /** Min backoff on retry. Default: 30 ms */
  min_backoff_ms?: number;
  /** Max backoff on retry. Default: 5000 ms */
  max_backoff_ms?: number;
};

export type RelabelAction = "keep" | "drop";

export type WriteRelabelConfig = {
  source_labels?: string[];
  regex?: string;
  action?: RelabelAction;
};

export type RemoteWriteConfig = {
  /** Target URL for Prometheus remote write endpoint (e.g. http://prometheus:9090/api/v1/write) */
  url: string;
  /** Remote write timeout in ms. Default: 30000 */
  remote_timeout_ms?: number;
  /** HTTP headers to send with each request */
  headers?: Record<string, string>;
  basic_auth?: BasicAuthConfig;
  bearer_token?: string;
  bearer_token_file?: string;
  tls_config?: TlsConfig;
  queue_config?: QueueConfig;
  write_relabel_configs?: WriteRelabelConfig[];
  /** Metric name prefix. Default: "openclaw" */
  metric_prefix?: string;
};

// ---- Relabel engine ----

function applyRelabelConfigs(
  labels: Array<{ name: string; value: string }>,
  configs: WriteRelabelConfig[],
): Array<{ name: string; value: string }> | null {
  for (const cfg of configs) {
    const sourceLabels = cfg.source_labels ?? ["__name__"];
    const sourceValue = sourceLabels
      .map((ln) => labels.find((l) => l.name === ln)?.value ?? "")
      .join(";");
    const regex = new RegExp(cfg.regex ?? "(.*)");
    const matches = regex.test(sourceValue);
    const action = cfg.action ?? "keep";
    if (action === "keep" && !matches) {
      return null;
    }
    if (action === "drop" && matches) {
      return null;
    }
  }
  return labels;
}

// ---- Remote Write Client ----

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export class RemoteWriteClient {
  private readonly config: RemoteWriteConfig;
  private readonly logger: Logger;
  private buffer: PromTimeSeries[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private readonly capacity: number;
  private readonly maxSamplesPerSend: number;
  private readonly batchDeadlineMs: number;
  private readonly maxRetries: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly timeoutMs: number;

  constructor(config: RemoteWriteConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    const qc = config.queue_config ?? {};
    this.capacity = qc.capacity ?? 2500;
    this.maxSamplesPerSend = qc.max_samples_per_send ?? 500;
    this.batchDeadlineMs = qc.batch_send_deadline_ms ?? 5000;
    this.maxRetries = qc.max_retries ?? 3;
    this.minBackoffMs = qc.min_backoff_ms ?? 30;
    this.maxBackoffMs = qc.max_backoff_ms ?? 5000;
    this.timeoutMs = config.remote_timeout_ms ?? 30_000;
  }

  /** Enqueue time series for batched sending. */
  enqueue(timeseries: PromTimeSeries[]): void {
    if (this.stopped) {
      return;
    }

    const filtered = this.applyRelabelFilters(timeseries);
    if (filtered.length === 0) {
      return;
    }

    this.buffer.push(...filtered);

    // Evict oldest if over capacity
    while (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }

    // Flush immediately if batch full
    if (this.buffer.length >= this.maxSamplesPerSend) {
      void this.flush();
      return;
    }

    // Schedule a deadline flush
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, this.batchDeadlineMs);
    }
  }

  /** Force flush all buffered data. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.maxSamplesPerSend);
      await this.sendBatch(batch);
    }
  }

  /** Stop the client and flush remaining data. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush().catch(() => undefined);
  }

  private applyRelabelFilters(timeseries: PromTimeSeries[]): PromTimeSeries[] {
    const configs = this.config.write_relabel_configs;
    if (!configs || configs.length === 0) {
      return timeseries;
    }
    return timeseries.filter((ts) => applyRelabelConfigs(ts.labels, configs) !== null);
  }

  private async sendBatch(batch: PromTimeSeries[]): Promise<void> {
    if (batch.length === 0) {
      return;
    }

    const protoBytes = encodeWriteRequest({ timeseries: batch });

    // Dynamic import snappyjs (pure-JS snappy block compression)
    const snappyModule = await import("snappyjs");
    const compress = snappyModule.default?.compress ?? snappyModule.compress;
    const compressed: Uint8Array = compress(protoBytes);

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const statusCode = await this.httpPost(compressed);
        if (statusCode >= 200 && statusCode < 300) {
          return;
        }
        if (statusCode === 400 || statusCode === 415) {
          // Permanent failure — do not retry per spec
          this.logger.error(
            `diagnostics-prometheus: remote write rejected with ${statusCode}, dropping ${batch.length} samples`,
          );
          return;
        }
        if (statusCode === 429 || (statusCode >= 500 && statusCode < 600)) {
          // Retryable
          if (attempt < this.maxRetries) {
            const backoff = this.calculateBackoff(attempt);
            this.logger.warn(
              `diagnostics-prometheus: remote write ${statusCode}, retrying in ${backoff}ms (attempt ${attempt + 1}/${this.maxRetries})`,
            );
            await this.sleep(backoff);
            continue;
          }
          this.logger.error(
            `diagnostics-prometheus: remote write failed after ${this.maxRetries} retries, dropping ${batch.length} samples`,
          );
          return;
        }
        // Unexpected status
        this.logger.warn(`diagnostics-prometheus: remote write unexpected status ${statusCode}`);
        return;
      } catch (err) {
        if (attempt < this.maxRetries) {
          const backoff = this.calculateBackoff(attempt);
          this.logger.warn(
            `diagnostics-prometheus: remote write error: ${formatError(err)}, retrying in ${backoff}ms`,
          );
          await this.sleep(backoff);
          continue;
        }
        this.logger.error(
          `diagnostics-prometheus: remote write failed: ${formatError(err)}, dropping ${batch.length} samples`,
        );
        return;
      }
    }
  }

  private httpPost(body: Uint8Array): Promise<number> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.config.url);
      const isHttps = url.protocol === "https:";
      const transport = isHttps ? https : http;

      const headers: Record<string, string> = {
        "Content-Type": "application/x-protobuf",
        "Content-Encoding": "snappy",
        "X-Prometheus-Remote-Write-Version": "0.1.0",
        "User-Agent": "openclaw-diagnostics-prometheus/1.0",
        ...(this.config.headers ?? {}),
      };

      // Authentication
      if (this.config.basic_auth) {
        const user = this.config.basic_auth.username ?? "";
        const pass =
          this.config.basic_auth.password ??
          (this.config.basic_auth.password_file
            ? fs.readFileSync(this.config.basic_auth.password_file, "utf-8").trim()
            : "");
        headers["Authorization"] = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
      } else if (this.config.bearer_token) {
        headers["Authorization"] = `Bearer ${this.config.bearer_token}`;
      } else if (this.config.bearer_token_file) {
        headers["Authorization"] =
          `Bearer ${fs.readFileSync(this.config.bearer_token_file, "utf-8").trim()}`;
      }

      const requestOptions: http.RequestOptions = {
        method: "POST",
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers,
        timeout: this.timeoutMs,
      };

      // TLS configuration
      if (isHttps && this.config.tls_config) {
        const tls = this.config.tls_config;
        if (tls.ca_file) {
          (requestOptions as https.RequestOptions).ca = fs.readFileSync(tls.ca_file);
        }
        if (tls.cert_file) {
          (requestOptions as https.RequestOptions).cert = fs.readFileSync(tls.cert_file);
        }
        if (tls.key_file) {
          (requestOptions as https.RequestOptions).key = fs.readFileSync(tls.key_file);
        }
        if (tls.server_name) {
          (requestOptions as https.RequestOptions).servername = tls.server_name;
        }
        if (tls.insecure_skip_verify) {
          (requestOptions as https.RequestOptions).rejectUnauthorized = false;
        }
      }

      const req = transport.request(requestOptions, (res) => {
        // Consume body to free socket
        res.resume();
        resolve(res.statusCode ?? 0);
      });

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("remote write request timed out"));
      });
      req.write(body);
      req.end();
    });
  }

  private calculateBackoff(attempt: number): number {
    const base = this.minBackoffMs * Math.pow(2, attempt);
    const capped = Math.min(base, this.maxBackoffMs);
    // Add jitter: ±25%
    const jitter = capped * 0.25 * (Math.random() * 2 - 1);
    return Math.round(capped + jitter);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return typeof err === "string" ? err : String(err);
}
