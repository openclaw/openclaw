// JSON-lines RPC client for the persistent per-scope pin owner (Stage S3).
//
// Owns the transport half of design v8 §3: it spawns the owner lazily, frames
// newline-delimited JSON over the owner's stdin/stdout, correlates responses by
// request id, and fails closed on every death path (owner exit, RPC EOF, write
// error, per-call timeout) by rejecting the affected calls. The owner is
// respawned on the next request after a death, so a crashed owner never wedges
// the scope — it just invalidates in-flight work (no partial write survives
// because each mutation is a single atomic syscall relative to a held fd).
//
// The HELD-pin table (opId -> canonical path) and the resource caps live in the
// bridge (fs-bridge.ts); this client is the raw request/response channel plus
// process supervision, so it stays small and independently testable.
import type { PersistentChildHandle } from "./scope-reaper.js";

/** A single owner RPC failure (owner returned ok:false). Carries the errno. */
export class PinOwnerError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "PinOwnerError";
  }
}

/** The owner process is gone (exited / EOF / disposed); the call failed closed. */
export class PinOwnerDeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinOwnerDeadError";
  }
}

type OwnerResponse = { id?: unknown; ok?: boolean; error?: string; errno?: string } & Record<
  string,
  unknown
>;

type PendingCall = {
  resolve: (value: OwnerResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type PinOwnerClientDeps = {
  /** Spawn a fresh sandboxed owner process. Called lazily and on respawn. */
  spawnOwner: () => Promise<PersistentChildHandle>;
  /** Per-request timeout; a slow/wedged owner fails the call closed. */
  rpcTimeoutMs: number;
};

/** File-backed resolve target: parent chain to hold + leaf to mutate. */
export type PinResolveTarget = {
  root: string;
  rel: string;
  leaf: string;
  mode: "file" | "dir";
};

export type PinMutation =
  | { kind: "write" | "create"; data: Buffer }
  | { kind: "mkdir" }
  | { kind: "remove"; recursive: boolean; force: boolean };

export type PinRenameTarget = {
  fromRoot: string;
  fromRel: string;
  fromLeaf: string;
  toRoot: string;
  toRel: string;
  toLeaf: string;
};

export class PinOwnerClient {
  private proc: PersistentChildHandle | undefined;
  /** Latch for the in-flight spawn so concurrent requests never double-spawn. */
  private spawning: Promise<PersistentChildHandle> | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private buffer = "";
  private disposed = false;

  constructor(private readonly deps: PinOwnerClientDeps) {}

  /** True while a live owner process is attached (test/introspection aid). */
  get isOwnerRunning(): boolean {
    return this.proc !== undefined;
  }

  private async ensureOwner(): Promise<PersistentChildHandle> {
    if (this.disposed) {
      throw new PinOwnerDeadError("pin owner client has been disposed");
    }
    if (this.proc) {
      return this.proc;
    }
    if (!this.spawning) {
      this.spawning = this.deps
        .spawnOwner()
        .then((proc) => {
          this.attachOwner(proc);
          return proc;
        })
        .finally(() => {
          this.spawning = undefined;
        });
    }
    return this.spawning;
  }

  private attachOwner(proc: PersistentChildHandle): void {
    this.proc = proc;
    this.buffer = "";
    proc.stdout.on("data", (chunk: Buffer | string) => {
      this.onStdout(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    proc.stdout.on("error", () => {});
    proc.stdin.on("error", () => {});
    proc.child.on("exit", (code, signal) => {
      this.onOwnerGone(proc, `pin owner exited (code=${String(code)}, signal=${String(signal)})`);
    });
    proc.child.on("error", (error: Error) => {
      this.onOwnerGone(proc, `pin owner failed to launch: ${error.message}`);
    });
  }

  private onStdout(text: string): void {
    this.buffer += text;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }
      let message: OwnerResponse;
      try {
        message = JSON.parse(trimmed) as OwnerResponse;
      } catch {
        // A non-JSON line is owner diagnostics on the wrong stream; ignore it
        // rather than tearing down healthy in-flight calls.
        continue;
      }
      const id = message.id;
      if (typeof id !== "number") {
        continue;
      }
      const call = this.pending.get(id);
      if (!call) {
        continue;
      }
      this.pending.delete(id);
      clearTimeout(call.timer);
      if (message.ok === true) {
        call.resolve(message);
      } else {
        call.reject(new PinOwnerError(message.error ?? "pin owner request failed", message.errno));
      }
    }
  }

  private onOwnerGone(proc: PersistentChildHandle, reason: string): void {
    if (this.proc !== proc) {
      return;
    }
    this.proc = undefined;
    this.buffer = "";
    const error = new PinOwnerDeadError(reason);
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }

  private async request(payload: Record<string, unknown>): Promise<OwnerResponse> {
    const proc = await this.ensureOwner();
    const id = this.nextRequestId++;
    return new Promise<OwnerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new PinOwnerError(`pin owner RPC timed out (op=${String(payload.op)})`));
        }
      }, this.deps.rpcTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        proc.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Walk + hold the parent chain for `opId`; the fds stay open until mutate/release. */
  async resolvePin(opId: number, target: PinResolveTarget): Promise<{ depth: number }> {
    const response = await this.request({ op: "resolve", opId, ...target });
    return { depth: typeof response.depth === "number" ? response.depth : 0 };
  }

  /** Perform the pinned mutation relative to the held parent fd, then release it. */
  async mutate(opId: number, mutation: PinMutation): Promise<{ result: string }> {
    const payload: Record<string, unknown> = { op: "mutate", opId, kind: mutation.kind };
    if (mutation.kind === "write" || mutation.kind === "create") {
      payload.data = mutation.data.toString("base64");
    } else if (mutation.kind === "remove") {
      payload.recursive = mutation.recursive;
      payload.force = mutation.force;
    }
    const response = await this.request(payload);
    return { result: typeof response.result === "string" ? response.result : "" };
  }

  /** Drop a held pin without mutating (denied authorization / idle timeout). */
  async release(opId: number): Promise<void> {
    try {
      await this.request({ op: "release", opId });
    } catch (error) {
      // A dead owner already released every fd by dying; a release RPC failure
      // is therefore never fatal.
      if (!(error instanceof PinOwnerDeadError)) {
        throw error;
      }
    }
  }

  async read(path: string, maxBytes?: number): Promise<Buffer> {
    const response = await this.request({ op: "read", path, maxBytes });
    return Buffer.from(typeof response.data === "string" ? response.data : "", "base64");
  }

  async stat(
    path: string,
  ): Promise<{ type: "file" | "directory" | "other"; size: number; mtimeMs: number } | null> {
    const response = await this.request({ op: "stat", path });
    const stat = response.stat as
      | { type: "file" | "directory" | "other"; size: number; mtimeMs: number }
      | null
      | undefined;
    return stat ?? null;
  }

  async rename(target: PinRenameTarget): Promise<void> {
    await this.request({ op: "rename", ...target });
  }

  /** Health probe: reports the owner pid, held-pin count, and open-fd count. */
  async ping(): Promise<{ pid: number; held: number; fds: number }> {
    const response = await this.request({ op: "ping" });
    return {
      pid: typeof response.pid === "number" ? response.pid : -1,
      held: typeof response.held === "number" ? response.held : -1,
      fds: typeof response.fds === "number" ? response.fds : -1,
    };
  }

  /** Reject every in-flight call and detach; the reaper group-kills the owner. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const proc = this.proc;
    if (proc) {
      this.onOwnerGone(proc, "pin owner client disposed");
      try {
        proc.stdin.end();
      } catch {
        // The reaper's dispose() group-kills the owner regardless.
      }
    }
  }
}
