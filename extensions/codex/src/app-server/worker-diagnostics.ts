import { randomUUID } from "node:crypto";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const METHOD = "openclaw/workerDiagnostic";
const PREFIX = Buffer.from(`{"method":"${METHOD}","params":`);
const MAX_LINE = 8192;
const LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"] as const;
const COMPONENTS = ["app_server", "core", "exec", "other"] as const;
const CATEGORIES = ["auth", "network", "timeout", "panic", "other"] as const;
const SIGNALS = [
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGABRT",
  "SIGSEGV",
  "SIGBUS",
  "SIGPIPE",
  "SIGHUP",
  "SIGQUIT",
] as const;

export type WorkerDuplexCloseOrigin =
  | "remote_resolved"
  | "remote_rejected"
  | "local_stdin_final"
  | "local_response_too_large"
  | "local_kill"
  | "local_abort"
  | "local_resource_failure"
  | "local_credential_failure";

type NativeExit = { event: "native_exit"; code: number | null; signal: string | null };
type WorkerDiagnostic =
  | NativeExit
  | {
      event: "native_stderr";
      level: (typeof LEVELS)[number];
      component: (typeof COMPONENTS)[number];
      category: (typeof CATEGORIES)[number];
      bytes: number;
    }
  | { event: "dropped"; count: number };

function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.some((item) => item === value);
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function exitCode(value: unknown): value is number | null {
  return value === null || (count(value) && value <= 2147483647);
}
function signalName(value: unknown): string | null {
  return member(SIGNALS, value) ? value : null;
}
function classify(text: string): (typeof CATEGORIES)[number] {
  if (/unauthorized|forbidden|authentication|credential|\b401\b|\b403\b/i.test(text)) {
    return "auth";
  }
  if (/timed?\s*out|timeout|deadline/i.test(text)) {
    return "timeout";
  }
  if (/panicked|\bpanic\b/i.test(text)) {
    return "panic";
  }
  if (/connection|disconnect|tunnel|socket|network|\bdns\b|broken pipe/i.test(text)) {
    return "network";
  }
  return "other";
}

/** Trace messages/spans can contain prompts and secrets. Only fixed classifications leave the node. */
export function createWorkerDiagnosticForwarder(send: (frame: Uint8Array) => Promise<void>) {
  let pending = Buffer.alloc(0);
  let oversized = false;
  let dropped = 0;
  let windowStart = Date.now();
  let admitted = 0;
  let finished = false;
  const queue: WorkerDiagnostic[] = [];
  let sending: Promise<void> | undefined;
  const pump = () => {
    if (sending || !queue.length) {
      return;
    }
    const event = queue.shift()!;
    sending = Promise.resolve()
      .then(() =>
        send(Buffer.from(JSON.stringify({ method: METHOD, params: { version: 1, ...event } }))),
      )
      .catch(() => {
        dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1);
      })
      .finally(() => {
        sending = undefined;
        pump();
      });
  };
  const reportDropped = () => {
    if (!dropped) {
      return;
    }
    queue.push({ event: "dropped", count: dropped });
    dropped = 0;
  };
  const line = (data: Buffer) => {
    let value: unknown;
    try {
      value = JSON.parse(data.toString("utf8"));
    } catch {
      dropped++;
      return;
    }
    if (!isRecord(value) || !member(LEVELS, value.level)) {
      dropped++;
      return;
    }
    if (Date.now() - windowStart >= 60_000) {
      windowStart = Date.now();
      admitted = 0;
      // A blocked transport owns at most eight queued records; counters never grow a queue.
      if (queue.length < 8) {
        reportDropped();
      }
    }
    if (admitted >= 20 || queue.length >= 8) {
      dropped++;
      return;
    }
    admitted++;
    const target = typeof value.target === "string" ? value.target : "";
    const component = target.startsWith("codex_app_server")
      ? "app_server"
      : target.startsWith("codex_core")
        ? "core"
        : target.startsWith("codex_exec")
          ? "exec"
          : "other";
    const text =
      isRecord(value.fields) && typeof value.fields.message === "string"
        ? value.fields.message
        : "";
    queue.push({
      event: "native_stderr",
      level: value.level,
      component,
      category: classify(text),
      bytes: data.length,
    });
    pump();
  };
  return {
    append(chunk: Uint8Array) {
      if (finished) {
        return;
      }
      const bytes = Buffer.from(chunk);
      let start = 0;
      while (start < bytes.length) {
        const newline = bytes.indexOf(10, start);
        const end = newline === -1 ? bytes.length : newline;
        const part = bytes.subarray(start, end);
        if (!oversized) {
          if (pending.length + part.length > MAX_LINE) {
            pending = Buffer.alloc(0);
            oversized = true;
          } else {
            pending = Buffer.concat([pending, part]);
          }
        }
        if (newline === -1) {
          break;
        }
        if (oversized) {
          dropped++;
        } else if (pending.length) {
          line(pending);
        }
        pending = Buffer.alloc(0);
        oversized = false;
        start = newline + 1;
      }
    },
    nativeExit(code: number | null, signal: string | null) {
      if (finished) {
        return;
      }
      // Two terminal slots are reserved beyond the eight ordinary records.
      reportDropped();
      queue.push({
        event: "native_exit",
        code: exitCode(code) ? code : null,
        signal: signalName(signal),
      });
      pump();
    },
    async finish() {
      finished = true;
      if (pending.length || oversized) {
        dropped++;
      }
      pending = Buffer.alloc(0);
      if (queue.length < 10) {
        reportDropped();
      }
      pump();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Diagnostics may be lost on disconnect. They never hold process/workspace cleanup hostage.
      await Promise.race([
        (async () => {
          let active = sending;
          while (active) {
            await active;
            active = sending;
          }
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 250);
        }),
      ]);
      clearTimeout(timer);
      queue.length = 0;
    },
  };
}

/** The remote node is a trust boundary; reconstruct the export from bounded enum/numeric fields. */
export function createWorkerDiagnosticReceiver() {
  const transportId = randomUUID();
  let native: NativeExit | undefined;
  let windowStart = Date.now();
  let received = 0;
  const log = (event: WorkerDiagnostic | Record<string, unknown>) => {
    embeddedAgentLog.info(
      `OPENCLAW_WORKER_DIAGNOSTIC_V1 ${JSON.stringify({ version: 1, transportId, ...event })}`,
    );
  };
  return {
    consume(frame: Uint8Array): boolean {
      if (!PREFIX.equals(frame.subarray(0, PREFIX.length))) {
        return false;
      }
      if (frame.byteLength > 1024) {
        return true;
      }
      const bytes = Buffer.from(frame);
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        return true;
      }
      if (!isRecord(value) || !isRecord(value.params) || value.params.version !== 1) {
        return true;
      }
      const p = value.params;
      if (Date.now() - windowStart >= 60_000) {
        windowStart = Date.now();
        received = 0;
      }
      if (
        p.event === "native_exit" &&
        !native &&
        exitCode(p.code) &&
        (p.signal === null || member(SIGNALS, p.signal))
      ) {
        native = { event: "native_exit", code: p.code, signal: p.signal };
        log(native);
      } else if (
        received < 22 &&
        p.event === "native_stderr" &&
        member(LEVELS, p.level) &&
        member(COMPONENTS, p.component) &&
        member(CATEGORIES, p.category) &&
        count(p.bytes) &&
        p.bytes <= MAX_LINE
      ) {
        received++;
        log({
          event: "native_stderr",
          level: p.level,
          component: p.component,
          category: p.category,
          bytes: p.bytes,
        });
      } else if (received < 22 && p.event === "dropped" && count(p.count)) {
        received++;
        log({ event: "dropped", count: p.count });
      }
      return true;
    },
    close(origin: WorkerDuplexCloseOrigin, cause?: unknown) {
      const code = native ? native.code : cause ? 1 : 0;
      const signal = native?.signal ?? null;
      const exitSource = native ? "native" : "synthetic";
      const causeClass =
        cause instanceof Error ? classify(cause.message) : cause === undefined ? "none" : "other";
      log({ event: "duplex_close", origin, exitSource, code, signal, causeClass });
      return {
        code,
        signal,
        error: new Error(
          `Codex worker app-server closed: origin=${origin} exitSource=${exitSource} code=${code} signal=${signal}`,
          { cause },
        ),
      };
    },
  };
}
