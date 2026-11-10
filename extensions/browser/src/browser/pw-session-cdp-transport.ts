import type { lookup as dnsLookupCb } from "node:dns";
import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import { asOptionalRecord, readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import type { Browser, ConnectOverCDPTransport } from "playwright-core";
import { isWebSocketUrl, openCdpWebSocket } from "./cdp.helpers.js";
import { resolveBrowserEngine } from "./engines/registry.js";
import type { BrowserEngineId } from "./engines/types.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
type CdpSocketLookup = typeof dnsLookupCb;
// Playwright allocates positive command IDs and reserves -9999 for Browser.close.
// Keep transport-owned replies below that range so Playwright never consumes them.
const FIRST_INTERNAL_COMMAND_ID = -10_000;
const MAX_DIAGNOSTIC_TARGETS = 3;
const MAX_DIAGNOSTIC_TARGET_ID_CHARS = 128;

type CdpPageTarget = { targetId: string; title: string; url: string; type: "page" };

const crashedTargetsByBrowser = new WeakMap<Browser, ReadonlyMap<string, CdpPageTarget>>();

/** Includes crashed targets that Playwright discards during a cold connection. */
export function getCrashedTargets(
  browser: Browser,
): ReadonlyMap<string, CdpPageTarget> | undefined {
  return crashedTargetsByBrowser.get(browser);
}

export class UnresponsiveCdpTargetError extends Error {
  constructor(targetIds: string[]) {
    const targets = targetIds.map((targetId) => JSON.stringify(targetId)).join(", ");
    const suffix = targetIds.length === 1 ? "" : "s";
    super(
      `Playwright connection timed out while page target${suffix} ${targets} did not respond during initialization. Close the target in the browser or provider dashboard, then retry. If it cannot be closed there, restart the affected browser profile.`,
    );
    this.name = "UnresponsiveCdpTargetError";
  }
}

function isConnectTimeout(error: unknown): boolean {
  if (error instanceof Error && error.name === "TimeoutError") {
    return true;
  }
  const message = formatErrorMessage(error).toLowerCase();
  return message.includes("timeout") || message.includes("timed out");
}

// Playwright's browser-root handler requires browserContextId for non-browser targets.
// Release only those root targets; nested sessions belong to Playwright's frame handler.
function contextlessTargetParams(
  message: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (readStringField(message, "method") !== "Target.attachedToTarget") {
    return undefined;
  }
  const params = asOptionalRecord(message.params);
  const targetInfo = asOptionalRecord(params?.targetInfo);
  if (
    readStringField(message, "sessionId") ||
    readStringField(targetInfo, "type") === "browser" ||
    readStringField(targetInfo, "browserContextId")
  ) {
    return undefined;
  }
  return params ?? {};
}

type CdpTransportOptions = {
  timeout: number;
  headers: Record<string, string>;
  lookup?: CdpSocketLookup;
  resolveWebSocketUrl?: () => Promise<string | undefined>;
  preparedTransport?: ConnectOverCDPTransport;
  engine?: BrowserEngineId;
};

async function openCdpTransportSocket(
  connectionUrl: string,
  opts: CdpTransportOptions,
): Promise<ConnectOverCDPTransport> {
  const resolvedConnectionUrl = isWebSocketUrl(connectionUrl)
    ? connectionUrl
    : await opts.resolveWebSocketUrl?.();
  if (!resolvedConnectionUrl) {
    throw new Error("CDP endpoint did not expose a usable WebSocket URL.");
  }
  const ws = openCdpWebSocket(resolvedConnectionUrl, {
    headers: opts.headers,
    handshakeTimeoutMs: opts.timeout,
    lookup: opts.lookup,
    playwrightTransportDefaults: true,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      ws.once("close", () => reject(new Error("CDP socket closed")));
    });
  } catch (error) {
    ws.close();
    throw error;
  }
  const wire: ConnectOverCDPTransport = {
    send: (message) => ws.send(JSON.stringify(message)),
    close: () => {
      ws.close();
      setTimeout(() => {
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.terminate();
        }
      }, 100).unref();
    },
  };
  ws.on("message", (raw) => {
    try {
      const parsed = asOptionalRecord(JSON.parse(rawDataToString(raw)));
      if (!parsed) {
        wire.close();
        return;
      }
      wire.onmessage?.(parsed);
    } catch {
      wire.close();
    }
  });
  ws.on("close", () => wire.onclose?.("CDP socket closed"));
  ws.on("error", (error) => wire.onclose?.(formatErrorMessage(error)));
  return wire;
}

export async function connectOverCdpTransport(
  connectionUrl: string,
  opts: CdpTransportOptions,
): Promise<Browser> {
  const normalizer = resolveBrowserEngine(opts.engine).createCdpNormalizer?.();
  const wire = opts.preparedTransport ?? (await openCdpTransportSocket(connectionUrl, opts));
  const pageTargetsBySession = new Map<string, CdpPageTarget>();
  const crashedTargets = new Map<string, CdpPageTarget>();
  const pendingTargetCommands = new Map<number, string>();
  let trackInitializationCommands = true;
  try {
    let onMessage: ((message: object) => void) | undefined;
    let onClose: ((reason?: string) => void) | undefined;
    const pendingMessages: object[] = [];
    let pendingCloseReason: string | undefined;
    let transportClosed = false;
    let closingReason: string | undefined;
    let transportCloseScheduled = false;
    let nextInternalCommandId = FIRST_INTERNAL_COMMAND_ID;
    const pendingContextlessTargetResumes = new Map<number, string>();
    const notifyTransportClosed = (reason: string) => {
      if (transportClosed) {
        return;
      }
      transportClosed = true;
      if (!trackInitializationCommands) {
        pageTargetsBySession.clear();
      }
      crashedTargets.clear();
      normalizer?.clear();
      if (onClose) {
        onClose(reason);
        return;
      }
      pendingCloseReason = reason;
    };
    const scheduleTransportClosed = (reason: string) => {
      if (transportClosed || transportCloseScheduled) {
        return;
      }
      transportCloseScheduled = true;
      setImmediate(() => {
        transportCloseScheduled = false;
        notifyTransportClosed(reason);
      });
    };
    const closeTransportSocket = (reason = "CDP socket closed") => {
      closingReason = reason;
      normalizer?.clear();
      // Borrowed streams close only after the real owner acknowledges native cleanup.
      wire.close();
    };
    const sendInternalCommand = (
      method: string,
      params: Record<string, unknown> | undefined,
      sessionId?: string,
    ): number => {
      const id = nextInternalCommandId--;
      wire.send({ id, method, ...(params ? { params } : {}), sessionId });
      return id;
    };
    const releaseContextlessTarget = (params: Record<string, unknown>) => {
      const sessionId = readStringField(params, "sessionId");
      if (!sessionId) {
        // A root attach without a session cannot use the session command path.
        // Consume only that malformed event so Playwright cannot crash before the
        // shared browser transport handles the next valid message.
        return;
      }
      // Chrome dispatches session and root commands independently. Wait for the
      // resume response before detach so the hidden target cannot stay paused.
      const resumeId = sendInternalCommand("Runtime.runIfWaitingForDebugger", undefined, sessionId);
      pendingContextlessTargetResumes.set(resumeId, sessionId);
    };
    const scheduleMessage = (message: object) => {
      setImmediate(() => {
        if (transportClosed || closingReason) {
          return;
        }
        if (!onMessage) {
          pendingMessages.push(message);
          return;
        }
        try {
          void Promise.resolve(onMessage(message)).catch((error: unknown) => {
            closeTransportSocket(formatErrorMessage(error));
          });
        } catch (error) {
          closeTransportSocket(formatErrorMessage(error));
        }
      });
    };
    const transport: ConnectOverCDPTransport = {
      send: (message) => {
        if (closingReason || transportClosed) {
          throw new Error("CDP transport closed");
        }
        const command = asOptionalRecord(message);
        const id = command?.id;
        const sessionId = readStringField(command, "sessionId");
        if (trackInitializationCommands && typeof id === "number" && id > 0 && sessionId) {
          pendingTargetCommands.set(id, sessionId);
        }
        try {
          wire.send(normalizer?.send(message) ?? message);
        } catch (error) {
          if (typeof id === "number") {
            pendingTargetCommands.delete(id);
          }
          closeTransportSocket(formatErrorMessage(error));
          throw error;
        }
      },
      close: () => {
        closeTransportSocket();
      },
      get onmessage() {
        return onMessage;
      },
      set onmessage(handler) {
        onMessage = handler;
        if (!handler) {
          return;
        }
        while (pendingMessages.length > 0) {
          const pending = pendingMessages.shift();
          if (pending) {
            scheduleMessage(pending);
          }
        }
      },
      get onclose() {
        return onClose;
      },
      set onclose(handler) {
        onClose = handler;
        if (handler && pendingCloseReason !== undefined) {
          const reason = pendingCloseReason;
          pendingCloseReason = undefined;
          handler(reason);
        }
      },
    };
    Object.assign(wire, {
      onmessage: (message: object) => {
        try {
          const received = asOptionalRecord(message);
          if (!received) {
            closeTransportSocket();
            return;
          }
          const messages = normalizer ? normalizer.receive(received) : [received];
          for (const parsed of messages) {
            const id = parsed.id;
            if (typeof id === "number" && id <= FIRST_INTERNAL_COMMAND_ID) {
              const targetSessionId = pendingContextlessTargetResumes.get(id);
              if (targetSessionId) {
                pendingContextlessTargetResumes.delete(id);
                sendInternalCommand("Target.detachFromTarget", { sessionId: targetSessionId });
              }
              continue;
            }
            if (typeof id === "number") {
              pendingTargetCommands.delete(id);
            }
            const method = readStringField(parsed, "method");
            const params = asOptionalRecord(parsed.params);
            const parentSessionId = readStringField(parsed, "sessionId");
            if (method === "Target.attachedToTarget" && !parentSessionId) {
              const sessionId = readStringField(params, "sessionId");
              const targetInfo = asOptionalRecord(params?.targetInfo);
              const targetId = readStringField(targetInfo, "targetId");
              if (
                sessionId &&
                targetId &&
                readStringField(targetInfo, "browserContextId") &&
                readStringField(targetInfo, "type") === "page"
              ) {
                pageTargetsBySession.set(sessionId, {
                  targetId,
                  title: readStringField(targetInfo, "title") ?? "",
                  url: readStringField(targetInfo, "url") ?? "",
                  type: "page",
                });
              }
            } else if (method === "Inspector.targetCrashed" && parentSessionId) {
              const target = pageTargetsBySession.get(parentSessionId);
              if (target) {
                // Playwright rejects a crashed session permanently, even if Chrome later reloads it.
                crashedTargets.set(target.targetId, target);
              }
            } else if (method === "Target.targetInfoChanged" && !parentSessionId) {
              const targetInfo = asOptionalRecord(params?.targetInfo);
              const targetId = readStringField(targetInfo, "targetId");
              for (const target of pageTargetsBySession.values()) {
                if (target.targetId === targetId) {
                  target.title = readStringField(targetInfo, "title") ?? target.title;
                  target.url = readStringField(targetInfo, "url") ?? target.url;
                }
              }
            } else if (method === "Target.detachedFromTarget") {
              const sessionId = readStringField(params, "sessionId");
              if (sessionId) {
                // Temporary CDP sessions cannot retire the root page's crash state.
                if (!parentSessionId) {
                  const target = pageTargetsBySession.get(sessionId);
                  if (target) {
                    crashedTargets.delete(target.targetId);
                  }
                  pageTargetsBySession.delete(sessionId);
                }
                for (const [commandId, pendingSessionId] of pendingTargetCommands) {
                  if (pendingSessionId === sessionId) {
                    pendingTargetCommands.delete(commandId);
                  }
                }
              }
            } else if (method === "Target.targetDestroyed" && !parentSessionId) {
              const targetId = readStringField(params, "targetId");
              if (targetId) {
                crashedTargets.delete(targetId);
                for (const [sessionId, target] of pageTargetsBySession) {
                  if (target.targetId === targetId) {
                    pageTargetsBySession.delete(sessionId);
                  }
                }
              }
            }
            const contextlessParams = contextlessTargetParams(parsed);
            if (contextlessParams) {
              releaseContextlessTarget(contextlessParams);
              continue;
            }
            scheduleMessage(parsed);
          }
        } catch {
          closeTransportSocket();
        }
      },
      onclose: (reason?: string) =>
        scheduleTransportClosed(closingReason ?? reason ?? "CDP socket closed"),
    });
    const browser = await getPlaywrightCore().chromium.connectOverCDP(transport, {
      timeout: opts.timeout,
    });
    // Only unanswered commands are startup diagnostics. Keep root page identities
    // for crash observation throughout this connection, including unpublished pages.
    trackInitializationCommands = false;
    pendingTargetCommands.clear();
    crashedTargetsByBrowser.set(browser, crashedTargets);
    return browser;
  } catch (error) {
    normalizer?.clear();
    wire.close();
    if (isConnectTimeout(error)) {
      // Playwright waits for every attached page to initialize. Preserve the
      // target/session facts already observed on this transport so operators
      // can remove only the renderer that blocked a cold connection.
      const targetIds = [
        ...new Set(
          [...pendingTargetCommands.values()]
            .map((sessionId) => pageTargetsBySession.get(sessionId)?.targetId)
            .filter(
              (targetId): targetId is string =>
                targetId !== undefined && targetId.length <= MAX_DIAGNOSTIC_TARGET_ID_CHARS,
            ),
        ),
      ].slice(0, MAX_DIAGNOSTIC_TARGETS);
      if (targetIds.length > 0) {
        throw new UnresponsiveCdpTargetError(targetIds);
      }
    }
    throw error;
  }
}
