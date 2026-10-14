#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  AGENT_METHODS,
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type AnyMessage,
} from "@agentclientprotocol/sdk";
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import type { AcpServerOptions } from "@openclaw/acp-core/types";
import { isRecord as isJsonObject } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { startGatewayClientWhenEventLoopReady } from "../../packages/gateway-client/src/readiness.js";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveGatewayClientBootstrap } from "../gateway/client-bootstrap.js";
import { GatewayClient } from "../gateway/client.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isMainModule } from "../infra/is-main.js";
import { routeLogsToStderr } from "../logging/console.js";
import { finalizeActiveDebugProxyCaptures } from "../proxy-capture/runtime-cleanup.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { createSqliteAcpEventLedger } from "./event-ledger.js";
import { readSecretFromFile } from "./secret-file.js";
import { AcpSessionNewOrdering } from "./session-new-ordering.js";
import { AcpGatewayAgent } from "./translator.js";
import { normalizeAcpProvenanceMode } from "./types.js";

type JsonObject = Record<string, unknown>;

const MAX_STARTUP_ACP_BUFFER_BYTES = 1024 * 1024;

function createStartupInputMonitor(input: ReadableStream<Uint8Array>): {
  dispose: () => void;
  ended: Promise<void>;
  takeReadable: () => ReadableStream<Uint8Array>;
} {
  const [monitor, readable] = input.tee();
  const reader = monitor.getReader();
  let readableTaken = false;
  let monitorCancelled = false;
  const cancelMonitor = (reason?: unknown) => {
    if (monitorCancelled) {
      return;
    }
    monitorCancelled = true;
    void reader.cancel(reason).catch(() => {});
  };
  const cancelBoth = (reason?: unknown) => {
    cancelMonitor(reason);
    void readable.cancel(reason).catch(() => {});
  };
  const ended = (async () => {
    try {
      let bufferedBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        // Drain raw stdin so EOF remains observable before Gateway hello. The
        // other branch retains the same bytes for the eventual SDK reader.
        bufferedBytes += value.byteLength;
        if (bufferedBytes > MAX_STARTUP_ACP_BUFFER_BYTES) {
          const error = new Error("ACP startup input exceeded the 1 MiB buffer limit");
          cancelBoth(error);
          throw error;
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();
  return {
    dispose: () => {
      if (!readableTaken) {
        cancelBoth();
      } else {
        cancelMonitor();
      }
    },
    ended,
    takeReadable: () => {
      readableTaken = true;
      return readable;
    },
  };
}

export async function serveAcpGateway(opts: AcpServerOptions = {}): Promise<void> {
  routeLogsToStderr();
  const cfg = getRuntimeConfig();
  const bootstrap = await resolveGatewayClientBootstrap({
    config: cfg,
    gatewayUrl: opts.gatewayUrl,
    explicitAuth: {
      token: opts.gatewayToken,
      password: opts.gatewayPassword,
    },
    env: process.env,
  });

  let agent: AcpGatewayAgent | null = null;
  let sessionStore: ReturnType<typeof createInMemorySessionStore> | null = null;
  const { promise: closed, resolve: onClosed, reject: onCloseFailed } = createDeferredCore();
  // Startup can still be awaiting Gateway readiness when shutdown fails.
  void closed.catch(() => {});
  const startupAbortController = new AbortController();
  let stopped = false;
  let gatewayConnected = false;
  const {
    promise: gatewayReady,
    resolve: resolveGatewayReady,
    reject: rejectReady,
  } = createDeferredCore();
  const rejectGatewayReady = (err: unknown) => {
    rejectReady(err instanceof Error ? err : new Error(String(err)));
  };
  const closeStateDatabase = async () => {
    const errors: unknown[] = [];
    try {
      await finalizeActiveDebugProxyCaptures();
    } catch (error) {
      errors.push(error);
    }
    try {
      await closeOpenClawStateDatabaseAsync();
    } catch (err) {
      console.warn(`acp: state database close failed during shutdown: ${formatErrorMessage(err)}`);
      errors.push(err);
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "ACP capture and state database shutdown failed.");
    }
  };

  const gateway = new GatewayClient({
    url: bootstrap.url,
    deviceAuthScope: bootstrap.deviceAuthScope,
    ...(bootstrap.sshTunnel ? { sshTunnel: bootstrap.sshTunnel } : {}),
    token: bootstrap.auth.token,
    password: bootstrap.auth.password,
    preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs,
    tlsFingerprint: bootstrap.tlsFingerprint,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    clientDisplayName: "ACP",
    clientVersion: "acp",
    mode: GATEWAY_CLIENT_MODES.CLI,
    caps: [GATEWAY_CLIENT_CAPS.EXEC_APPROVALS, GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
    onEvent: (evt) => {
      if (stopped) {
        return;
      }
      // Gateway delivery stays non-blocking, but translator failures must not
      // escape this callback as unhandled process rejections.
      void agent?.handleGatewayEvent(evt).catch((err: unknown) => {
        process.stderr.write(`openclaw acp: gateway event ${evt.event} failed\n`);
        if (opts.verbose) {
          process.stderr.write(
            `openclaw acp: gateway event ${evt.event} error: ${formatErrorMessage(err)}\n`,
          );
        }
      });
    },
    onHelloOk: () => {
      gatewayConnected = true;
      resolveGatewayReady();
      agent?.handleGatewayReconnect();
    },
    onConnectError: (err) => {
      rejectGatewayReady(err);
    },
    onClose: (code, reason) => {
      if (stopped) {
        return;
      }
      rejectGatewayReady(new Error(`gateway closed before ready (${code}): ${reason}`));
      agent?.handleGatewayDisconnect(`${code}: ${reason}`);
    },
  });
  // Monitor EOF before Gateway hello while retaining bounded input for the SDK.
  const rawInput = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const startupInput = createStartupInputMonitor(rawInput);

  const inputLifetime = new AbortController();
  let inputClosed: Promise<void> | undefined;
  let connection: AgentSideConnection | undefined;
  const onSignal = () => {
    void shutdown();
  };
  let shuttingDown: Promise<void> | undefined;
  let stoppingAgent: AcpGatewayAgent | null = null;
  const shutdown = () => {
    if (shuttingDown) {
      return shuttingDown;
    }
    shuttingDown = (async () => {
      if (!stopped) {
        stopped = true;
        startupAbortController.abort();
        startupInput.dispose();
        process.stdin.pause();
        resolveGatewayReady();
        // Revoke ledger access before transport teardown. Retain its cleanup
        // owner until shutdown succeeds, including across a failed drain.
        stoppingAgent = agent;
        agent = null;
      }
      await stoppingAgent?.shutdown();
      // The SDK only closes when its reader ends. Pausing Node stdin alone
      // leaves its Web-stream reader alive after SIGINT/SIGTERM.
      inputLifetime.abort();
      await inputClosed;
      await connection?.closed;
      stoppingAgent = null;
      // This injected store remains caller-owned through failed shutdown retries.
      sessionStore?.dispose();
      sessionStore = null;
      const gatewayStop = gateway.stopAndWait().catch((err: unknown) => {
        console.warn(`acp: gateway stop failed during shutdown: ${formatErrorMessage(err)}`);
      });
      await gatewayStop;
      await closeStateDatabase();
      onClosed();
    })();
    void shuttingDown.catch((error: unknown) => {
      shuttingDown = undefined;
      onCloseFailed(error);
    });
    return shuttingDown;
  };

  void startupInput.ended
    .then(() => {
      if (!gatewayConnected) {
        void shutdown();
      }
    }, shutdown)
    .catch(onCloseFailed);

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    // Wait for Gateway hello before dispatching buffered ACP requests.
    const readiness = await startGatewayClientWhenEventLoopReady(gateway, {
      clientOptions: { preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs },
      signal: startupAbortController.signal,
    });
    if (!readiness.ready) {
      rejectGatewayReady(new Error("gateway event loop readiness timeout"));
    }
    await gatewayReady.catch(async (err: unknown) => {
      await shutdown();
      throw err;
    });
    if (stopped) {
      return await closed;
    }

    const bufferedInput = startupInput.takeReadable();
    startupInput.dispose();
    const output = Writable.toWeb(process.stdout);
    const stream = ndJsonStream(output, bufferedInput);
    const sessionNewOrdering = new AcpSessionNewOrdering();
    // Store-owned reaping and eviction must retire ordering state, just like session/close.
    sessionStore = createInMemorySessionStore({
      onSessionRemoved: (sessionId) => sessionNewOrdering.forget(sessionId),
    });
    const inbound = new TransformStream<AnyMessage, AnyMessage>({
      transform(message, controller) {
        if (stopped) {
          return;
        }
        sessionNewOrdering.observeInbound(message);
        controller.enqueue(normalizeAcpInitializeProtocolVersion(message));
      },
    });
    inputClosed = stream.readable
      .pipeTo(inbound.writable, { signal: inputLifetime.signal })
      .catch((error: unknown) => {
        if (!inputLifetime.signal.aborted) {
          void shutdown();
          if (opts.verbose) {
            process.stderr.write(
              `openclaw acp: inbound stream failed: ${formatErrorMessage(error)}\n`,
            );
          }
        }
      });
    const readable = inbound.readable;
    const orderedOutbound = new TransformStream<AnyMessage, AnyMessage>({
      transform(message, controller) {
        sessionNewOrdering.transformOutbound(message, controller);
      },
    });
    // Writer failure must close the Gateway and database, just like EOF and SIGTERM.
    void orderedOutbound.readable
      .pipeTo(stream.writable)
      .catch(async (err: unknown) => {
        if (opts.verbose) {
          process.stderr.write(
            `openclaw acp: outbound stream failed: ${formatErrorMessage(err)}\n`,
          );
        }
        await shutdown();
      })
      .catch(onCloseFailed);
    const eventLedger = createSqliteAcpEventLedger();

    connection = new AgentSideConnection(
      (conn: AgentSideConnection) => {
        agent = new AcpGatewayAgent(conn, gateway, {
          ...opts,
          eventLedger,
          sessionStore: sessionStore ?? undefined,
        });
        agent.start();
        return agent;
      },
      { writable: orderedOutbound.writable, readable },
    );
    // SDK EOF must also close the Gateway and database.
    void connection.closed.then(shutdown, shutdown).catch(onCloseFailed);

    return await closed;
  } catch (error) {
    if (!stopped) {
      await shutdown();
    }
    throw error;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

function normalizeAcpInitializeProtocolVersion(message: AnyMessage): AnyMessage {
  if (!isJsonObject(message)) {
    return message;
  }
  const messageObject: JsonObject = message;
  if (messageObject.method !== AGENT_METHODS.initialize) {
    return message;
  }
  const params = messageObject.params;
  if (!isJsonObject(params) || isUint16Integer(params.protocolVersion)) {
    return message;
  }

  // ACP SDK 0.22 validates this uint16 before the agent handler runs; some
  // editors send MCP date strings here, so normalize only this handshake field.
  return {
    ...message,
    params: {
      ...params,
      protocolVersion: PROTOCOL_VERSION,
    },
  } as AnyMessage;
}

function isUint16Integer(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff;
}

function parseArgs(args: string[]): AcpServerOptions | undefined {
  const opts: AcpServerOptions = {};
  let tokenFile: string | undefined;
  let passwordFile: string | undefined;
  const stringOptions = new Map<
    string,
    keyof Pick<
      AcpServerOptions,
      | "gatewayUrl"
      | "gatewayToken"
      | "gatewayPassword"
      | "defaultSessionKey"
      | "defaultSessionLabel"
    >
  >([
    ["--url", "gatewayUrl"],
    ["--gateway-url", "gatewayUrl"],
    ["--token", "gatewayToken"],
    ["--gateway-token", "gatewayToken"],
    ["--password", "gatewayPassword"],
    ["--gateway-password", "gatewayPassword"],
    ["--session", "defaultSessionKey"],
    ["--session-label", "defaultSessionLabel"],
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const field = arg === undefined ? undefined : stringOptions.get(arg);
    if (field) {
      opts[field] = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--token-file" || arg === "--gateway-token-file") {
      tokenFile = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--password-file" || arg === "--gateway-password-file") {
      passwordFile = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--require-existing") {
      opts.requireExistingSession = true;
      continue;
    }
    if (arg === "--reset-session") {
      opts.resetSession = true;
      continue;
    }
    if (arg === "--no-prefix-cwd") {
      opts.prefixCwd = false;
      continue;
    }
    if (arg === "--provenance") {
      const provenanceMode = normalizeAcpProvenanceMode(args[i + 1]);
      if (!provenanceMode) {
        throw new Error("Invalid --provenance value. Use off, meta, or meta+receipt.");
      }
      opts.provenanceMode = provenanceMode;
      i += 1;
      continue;
    }
    if (arg === "--verbose" || arg === "-v") {
      opts.verbose = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      return undefined;
    }
  }
  const gatewayToken = normalizeOptionalString(opts.gatewayToken);
  const gatewayPassword = normalizeOptionalString(opts.gatewayPassword);
  const normalizedTokenFile = normalizeOptionalString(tokenFile);
  const normalizedPasswordFile = normalizeOptionalString(passwordFile);
  if (gatewayToken && normalizedTokenFile) {
    throw new Error("Use either --token or --token-file.");
  }
  if (gatewayPassword && normalizedPasswordFile) {
    throw new Error("Use either --password or --password-file.");
  }
  if (normalizedTokenFile) {
    opts.gatewayToken = readSecretFromFile(normalizedTokenFile, "Gateway token");
  }
  if (normalizedPasswordFile) {
    opts.gatewayPassword = readSecretFromFile(normalizedPasswordFile, "Gateway password");
  }
  return opts;
}

function printHelp(): void {
  console.log(`Usage: openclaw acp [options]

Gateway-backed ACP server for IDE integration.

Options:
  --url <url>             Gateway WebSocket URL
  --token <token>         Gateway auth token
  --token-file <path>     Read gateway auth token from file
  --password <password>   Gateway auth password
  --password-file <path>  Read gateway auth password from file
  --session <key>         Default session key (e.g. "agent:main:main")
  --session-label <label> Default session label to resolve
  --require-existing      Fail if the session key/label does not exist
  --reset-session         Reset the session key before first use
  --no-prefix-cwd         Do not prefix prompts with the working directory
  --provenance <mode>     ACP provenance mode: off, meta, or meta+receipt
  --verbose, -v           Verbose logging to stderr
  --help, -h              Show this help message
`);
}

if (isMainModule({ currentFile: fileURLToPath(import.meta.url) })) {
  const argv = process.argv.slice(2);
  if (argv.includes("--token") || argv.includes("--gateway-token")) {
    console.error(
      "Warning: --token can be exposed via process listings. Prefer --token-file or OPENCLAW_GATEWAY_TOKEN.",
    );
  }
  if (argv.includes("--password") || argv.includes("--gateway-password")) {
    console.error(
      "Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.",
    );
  }
  const opts = parseArgs(argv);
  if (opts) {
    serveAcpGateway(opts).catch((err: unknown) => {
      console.error(formatErrorMessage(err));
      process.exitCode = 1;
    });
  }
}
