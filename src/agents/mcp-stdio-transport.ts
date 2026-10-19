/**
 * OpenClaw stdio transport wrapper for MCP server subprocesses.
 */
import fs from "node:fs/promises";
import process from "node:process";
import { PassThrough } from "node:stream";
import {
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
  serializeMessage,
  type Transport,
  type JSONRPCMessage,
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { throwCollectedErrors } from "../infra/error-graph-internal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { mergeProcessEnv } from "../infra/process-env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  closeOwnedStdioProcess,
  createOwnedStdioProcess,
  OwnedStdioCleanupError,
  type OwnedStdioProcess,
} from "../process/owned-stdio.js";
import type { ProcessCleanupResult } from "../process/supervisor/types.js";
import { parseMcpDockerCommand } from "./mcp-docker-command.js";
import { McpStdioFrameDecoder } from "./mcp-stdio-frame-decoder.js";
import { recordAgentCleanupFailure } from "./run-cleanup-timeout.js";

const log = createSubsystemLogger("mcp/stdio");

type McpStdioDecoder = Pick<McpStdioFrameDecoder, "append" | "readMessage" | "clear">;

type McpStdioExit = { code: number | null; signal: NodeJS.Signals | null };

type OpenClawStdioServerParameters = {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** Use only the supplied environment, including explicit omissions. */
  exactEnv?: true;
  /** The decoder owns byte bounds and frame validation. */
  decoder?: McpStdioDecoder;
  cwd?: string;
  prepareDataDir?: string;
  stderr?: "pipe" | "overlapped" | "inherit" | "ignore";
};

export class OpenClawStdioClientTransport extends EventTarget implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  onexit?: (exit: McpStdioExit) => void;

  private readonly readBuffer: McpStdioDecoder;
  private readonly stderrStream: PassThrough | null = null;
  private process?: OwnedStdioProcess;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private forceRequested = false;
  private closeNotified = false;
  private readonly startupAbort = new AbortController();
  private startupCleanupError?: OwnedStdioCleanupError;
  private cleanup?: ProcessCleanupResult;
  private docker?: Awaited<
    ReturnType<typeof import("./mcp-docker-custody.js").prepareMcpDockerLaunch>
  >;

  constructor(private readonly serverParams: OpenClawStdioServerParameters) {
    super();
    // Keep malformed-frame errors visible; the v2 SDK buffer silently drops invalid JSON.
    this.readBuffer =
      serverParams.decoder ?? new McpStdioFrameDecoder(STDIO_DEFAULT_MAX_BUFFER_SIZE, "transport");
    if (serverParams.stderr === "pipe" || serverParams.stderr === "overlapped") {
      this.stderrStream = new PassThrough();
    }
  }

  async start(): Promise<void> {
    if (this.starting || this.closing) {
      throw new Error(
        "OpenClawStdioClientTransport already started or closed; Client.connect() starts transports automatically.",
      );
    }
    this.starting = this.startProcess();
    return this.starting;
  }

  private async startProcess(): Promise<void> {
    const prepareDataDir = this.serverParams.prepareDataDir?.trim();
    if (prepareDataDir) {
      try {
        await fs.mkdir(prepareDataDir, { recursive: true });
      } catch (error) {
        throw new Error(
          `unable to prepare PLUGIN_DATA directory "${prepareDataDir}": ${formatErrorMessage(error)}`,
          { cause: error },
        );
      }
    }

    // Directory preparation may finish after shutdown has retired this launch.
    if (this.startupAbort.signal.aborted) {
      throw new Error("MCP stdio transport is closed");
    }

    try {
      const env = this.serverParams.exactEnv
        ? mergeProcessEnv([this.serverParams.env])
        : mergeProcessEnv([getDefaultEnvironment(), this.serverParams.env]);
      const parsed = parseMcpDockerCommand(this.serverParams.command, this.serverParams.args);
      if (parsed.kind === "unsafe") {
        log.warn(
          `Docker MCP container custody unavailable: ${parsed.reason}. Use a direct docker run argument array for automatic cleanup.`,
        );
      } else if (parsed.kind === "docker") {
        const { prepareMcpDockerLaunch } = await import("./mcp-docker-custody.js");
        this.docker = await prepareMcpDockerLaunch(parsed, env, this.serverParams.cwd);
      }
      if (this.startupAbort.signal.aborted) {
        throw new Error("MCP stdio transport is closed");
      }
      const child = await createOwnedStdioProcess({
        argv: this.docker
          ? [this.docker.command, ...this.docker.args]
          : [this.serverParams.command, ...(this.serverParams.args ?? [])],
        cwd: this.serverParams.cwd,
        env: this.docker?.env ?? env,
        ...(this.serverParams.exactEnv ? { exactEnv: true as const } : {}),
        // A canceled Docker client can leave an accepted daemon-side create in
        // flight. Custody must see its CID before host-process cancellation.
        ...(this.docker
          ? { assertCurrent: this.docker.assertCurrent }
          : { abortSignal: this.startupAbort.signal }),
        stderrDestination:
          this.stderrStream ?? (this.serverParams.stderr === "ignore" ? undefined : process.stderr),
      });
      this.process = child;
      child.onError((error) => this.notifyError(error));
      const receive = (chunk: Buffer) => {
        if (this.closing) {
          return;
        }
        try {
          this.readBuffer.append(chunk);
          this.processReadBuffer();
        } catch (error) {
          this.notifyError(error instanceof Error ? error : new Error(String(error)));
          void this.close().catch(() => {});
        }
      };
      child.onStdout((text) => {
        if (!child.supportsRawOutput) {
          receive(Buffer.from(text));
        }
      }, receive);
      if (this.serverParams.stderr === "ignore") {
        child.onStderr(() => {});
      }
      // Root closure retires the connection immediately; the retained owner still
      // joins descendants before disposal can certify completed cleanup.
      void child.wait().then(
        (exit) => {
          try {
            this.dispatchEvent(new Event("exit"));
            this.onexit?.(exit);
          } catch (error) {
            this.notifyError(error instanceof Error ? error : new Error(String(error)));
          } finally {
            void this.close().catch(() => {});
            this.notifyClosed();
          }
        },
        (error: unknown) => {
          this.notifyError(error instanceof Error ? error : new Error(String(error)));
          void this.close().catch(() => {});
          this.notifyClosed();
        },
      );
    } catch (error) {
      if (error instanceof OwnedStdioCleanupError) {
        this.startupCleanupError = error;
        recordAgentCleanupFailure();
      }
      if (this.docker && !this.process) {
        // Failed spawn cleanup does not prove that the Docker client exited.
        // Keep watching for its CID while reporting the startup failure now.
        const cleanup = this.docker
          .close(this.startupCleanupError ? undefined : Promise.resolve())
          .catch((cleanupError: unknown) => {
            recordAgentCleanupFailure();
            this.notifyError(
              cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
            );
          });
        if (!this.startupCleanupError) {
          await cleanup;
        }
      }
      this.notifyError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  get stderr() {
    return this.stderrStream;
  }

  get pid() {
    return this.process?.pid ?? null;
  }

  get cleanupResult() {
    return this.cleanup;
  }

  private notifyError(error: Error): void {
    // Observe failures before SDK callbacks can request cleanup or replace handlers.
    this.dispatchEvent(new Event("error"));
    this.onerror?.(error);
  }

  private notifyClosed(): void {
    if (this.closeNotified) {
      return;
    }
    this.closeNotified = true;
    this.onclose?.();
  }

  private processReadBuffer() {
    while (!this.closing) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) {
          break;
        }
        this.onmessage?.(message);
      } catch (error) {
        this.notifyError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  close(): Promise<void> {
    if (this.starting && !this.process) {
      this.startupAbort.abort();
    }
    this.closing ??= (async () => {
      // A connect timeout can request disposal while the spawn owner is admitting.
      await this.starting?.catch(() => undefined);
      try {
        const failures: unknown[] = [];
        if (this.docker) {
          try {
            await this.docker.close(
              this.process?.wait() ?? (this.startupCleanupError ? undefined : Promise.resolve()),
            );
          } catch (error) {
            failures.push(error);
          }
        }
        if (this.startupCleanupError) {
          failures.push(this.startupCleanupError);
        }
        if (this.process) {
          try {
            this.cleanup = await closeOwnedStdioProcess(this.process, {
              force: this.forceRequested,
            });
          } catch (error) {
            failures.push(error);
          }
        }
        throwCollectedErrors(failures, "MCP container and host-process cleanup failed");
      } catch (error) {
        recordAgentCleanupFailure();
        throw error;
      } finally {
        this.process = undefined;
        this.readBuffer.clear();
        this.stderrStream?.end();
        this.notifyClosed();
      }
    })();
    // Attach observation in this caller's scope, including already failed startup.
    void this.closing.catch(() => recordAgentCleanupFailure());
    return this.closing;
  }

  /** Retire RPC admission now; the returned promise still joins owned-process cleanup. */
  retire(): Promise<void> {
    const closing = this.close();
    this.readBuffer.clear();
    this.notifyClosed();
    return closing;
  }

  terminate(): Promise<void> {
    if (!this.docker) {
      this.process?.kill("SIGTERM");
    }
    return this.retire();
  }

  forceClose(): Promise<void> {
    this.forceRequested = true;
    if (this.docker) {
      this.docker.force();
    } else {
      this.process?.kill("SIGKILL");
    }
    return this.close();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.closing ? undefined : this.process?.stdin;
      if (!stdin) {
        throw new Error("Not connected");
      }
      const json = serializeMessage(message);
      // Settle from the write callback so async EPIPE rejects instead of
      // escaping to uncaughtException. (#75438)
      stdin.write(json, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}
