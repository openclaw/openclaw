import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { TransportClosedError } from "../errors.js";
import type { JsonRpcMessage } from "../jsonrpc.js";
import { ListenerSet, type Unsubscribe } from "../subscriptions.js";
import { JsonlMessageBuffer, encodeJsonlMessage } from "./jsonl.js";

export interface TransportCloseEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
  hadError: boolean;
}

export interface AppServerTransport {
  readonly closed: boolean;
  write(message: JsonRpcMessage): void;
  close(): Promise<TransportCloseEvent>;
  onMessage(listener: (message: JsonRpcMessage) => void): Unsubscribe;
  onError(listener: (error: Error) => void): Unsubscribe;
  onClose(listener: (event: TransportCloseEvent) => void): Unsubscribe;
  onStderr(listener: (chunk: string) => void): Unsubscribe;
}

export interface SpawnCodexAppServerTransportOptions {
  bin?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  configOverrides?: string[];
  enableFeatures?: string[];
  disableFeatures?: string[];
  analyticsDefaultEnabled?: boolean;
}

export class CodexAppServerProcessTransport implements AppServerTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly parser = new JsonlMessageBuffer();
  private readonly messageListeners = new ListenerSet<[JsonRpcMessage]>();
  private readonly errorListeners = new ListenerSet<[Error]>();
  private readonly closeListeners = new ListenerSet<[TransportCloseEvent]>();
  private readonly stderrListeners = new ListenerSet<[string]>();
  private readonly closePromise: Promise<TransportCloseEvent>;
  private resolveClose!: (event: TransportCloseEvent) => void;
  private hadError = false;
  closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.closePromise = new Promise<TransportCloseEvent>((resolve) => {
      this.resolveClose = resolve;
    });

    this.parser.onMessage((message) => {
      this.messageListeners.emit(message);
    });

    this.parser.onError((error) => {
      this.hadError = true;
      this.errorListeners.emit(error);
      void this.close();
    });

    this.child.stdout.on("data", (chunk: Buffer | string) => {
      this.parser.push(chunk);
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrListeners.emit(chunk);
    });

    this.child.on("error", (error) => {
      this.hadError = true;
      this.errorListeners.emit(error);
    });

    this.child.on("close", (code, signal) => {
      if (this.closed) {
        return;
      }

      this.closed = true;
      const event = {
        code,
        signal,
        hadError: this.hadError,
      } satisfies TransportCloseEvent;
      this.resolveClose(event);
      this.closeListeners.emit(event);
    });
  }

  static async spawn(
    options: SpawnCodexAppServerTransportOptions = {},
  ): Promise<CodexAppServerProcessTransport> {
    const child = spawn(options.bin ?? "codex", buildArgs(options), {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return new CodexAppServerProcessTransport(child);
  }

  write(message: JsonRpcMessage): void {
    if (this.closed || this.child.stdin.destroyed) {
      throw new TransportClosedError();
    }

    this.child.stdin.write(encodeJsonlMessage(message));
  }

  async close(): Promise<TransportCloseEvent> {
    if (this.closed) {
      return this.closePromise;
    }

    this.child.stdin.end();
    if (!this.child.killed) {
      this.child.kill("SIGTERM");
    }

    return this.closePromise;
  }

  onMessage(listener: (message: JsonRpcMessage) => void): Unsubscribe {
    return this.messageListeners.subscribe(listener);
  }

  onError(listener: (error: Error) => void): Unsubscribe {
    return this.errorListeners.subscribe(listener);
  }

  onClose(listener: (event: TransportCloseEvent) => void): Unsubscribe {
    return this.closeListeners.subscribe(listener);
  }

  onStderr(listener: (chunk: string) => void): Unsubscribe {
    return this.stderrListeners.subscribe(listener);
  }
}

function buildArgs(options: SpawnCodexAppServerTransportOptions): string[] {
  const args = ["app-server"];

  for (const configOverride of options.configOverrides ?? []) {
    args.push("-c", configOverride);
  }

  for (const feature of options.enableFeatures ?? []) {
    args.push("--enable", feature);
  }

  for (const feature of options.disableFeatures ?? []) {
    args.push("--disable", feature);
  }

  if (options.analyticsDefaultEnabled) {
    args.push("--analytics-default-enabled");
  }

  args.push(...(options.args ?? []));
  return args;
}
