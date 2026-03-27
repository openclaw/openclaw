import net from "node:net";
import tls from "node:tls";
import {
  parseIrcLine,
  parseIrcPrefix,
  sanitizeIrcOutboundText,
  sanitizeIrcTarget,
} from "./protocol.js";

const IRC_ERROR_CODES = new Set(["432", "464", "465"]);
const IRC_NICK_COLLISION_CODES = new Set(["433", "436"]);

export type IrcPrivmsgEvent = {
  senderNick: string;
  senderUser?: string;
  senderHost?: string;
  target: string;
  text: string;
  rawLine: string;
};

export type IrcClientOptions = {
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  username: string;
  realname: string;
  password?: string;
  nickserv?: IrcNickServOptions;
  channels?: string[];
  connectTimeoutMs?: number;
  messageChunkMaxChars?: number;
  abortSignal?: AbortSignal;
  onPrivmsg?: (event: IrcPrivmsgEvent) => void | Promise<void>;
  onNotice?: (text: string, target?: string) => void;
  onError?: (error: Error) => void;
  onLine?: (line: string) => void;
};

export type IrcNickServOptions = {
  enabled?: boolean;
  service?: string;
  password?: string;
  register?: boolean;
  registerEmail?: string;
};

export type IrcClient = {
  nick: string;
  isReady: () => boolean;
  sendRaw: (line: string) => void;
  join: (channel: string) => void;
  sendPrivmsg: (target: string, text: string) => void;
  quit: (reason?: string) => void;
  close: () => void;
};

function toError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  return new Error(typeof err === "string" ? err : JSON.stringify(err));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function buildFallbackNick(nick: string): string {
  const normalized = nick.replace(/\s+/g, "");
  const safe = normalized.replace(/[^A-Za-z0-9_\-\[\]\\`^{}|]/g, "");
  const base = safe || "openclaw";
  const suffix = "_";
  const maxNickLen = 30;
  if (base.length >= maxNickLen) {
    return `${base.slice(0, maxNickLen - suffix.length)}${suffix}`;
  }
  return `${base}${suffix}`;
}

export function buildIrcNickServCommands(options?: IrcNickServOptions): string[] {
  if (!options || options.enabled === false) {
    return [];
  }
  const password = sanitizeIrcOutboundText(options.password ?? "");
  if (!password) {
    return [];
  }
  const service = sanitizeIrcTarget(options.service?.trim() || "NickServ");
  const commands = [`PRIVMSG ${service} :IDENTIFY ${password}`];
  if (options.register) {
    const registerEmail = sanitizeIrcOutboundText(options.registerEmail ?? "");
    if (!registerEmail) {
      throw new Error("IRC NickServ register requires registerEmail");
    }
    commands.push(`PRIVMSG ${service} :REGISTER ${password} ${registerEmail}`);
  }
  return commands;
}

export async function connectIrcClient(options: IrcClientOptions): Promise<IrcClient> {
  const timeoutMs = options.connectTimeoutMs != null ? options.connectTimeoutMs : 15000;
  const messageChunkMaxChars =
    options.messageChunkMaxChars != null ? options.messageChunkMaxChars : 350;

  if (!options.host.trim()) {
    throw new Error("IRC host is required");
  }
  if (!options.nick.trim()) {
    throw new Error("IRC nick is required");
  }

  const desiredNick = options.nick.trim();
  let currentNick = desiredNick;
  let ready = false;
  let closed = false;
  let nickServRecoverAttempted = false;
  let fallbackNickAttempted = false;

  // Incoming batch state: batchId -> messages
  const incomingBatches = new Map<string, Array<{
    senderNick: string;
    senderUser?: string;
    senderHost?: string;
    target: string;
    text: string;
  }>>();
  let multilineCap = false;
  let batchCounter = 0;
  let accumulatedCaps = ""; // Accumulate caps across multi-chunk CAP LS responses
  let resolveCapComplete: (() => void) | null = null;
  const capCompletePromise = new Promise<void>((resolve) => {
    resolveCapComplete = resolve;
  });

  const socket = options.tls
    ? tls.connect({
        host: options.host,
        port: options.port,
        servername: options.host,
      })
    : net.connect({ host: options.host, port: options.port });

  socket.setEncoding("utf8");

  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const fail = (err: unknown) => {
    const error = toError(err);
    if (options.onError) {
      options.onError(error);
    }
    if (!ready && rejectReady) {
      rejectReady(error);
      rejectReady = null;
      resolveReady = null;
    }
  };

  const sendRaw = (line: string) => {
    const cleaned = line.replace(/[\r\n]+/g, "").trim();
    if (!cleaned) {
      throw new Error("IRC command cannot be empty");
    }
    socket.write(`${cleaned}\r\n`);
  };

  const tryRecoverNickCollision = (): boolean => {
    const nickServEnabled = options.nickserv?.enabled !== false;
    const nickservPassword = sanitizeIrcOutboundText(options.nickserv?.password ?? "");
    if (nickServEnabled && !nickServRecoverAttempted && nickservPassword) {
      nickServRecoverAttempted = true;
      try {
        const service = sanitizeIrcTarget(options.nickserv?.service?.trim() || "NickServ");
        sendRaw(`PRIVMSG ${service} :GHOST ${desiredNick} ${nickservPassword}`);
        sendRaw(`NICK ${desiredNick}`);
        return true;
      } catch (err) {
        fail(err);
      }
    }

    if (!fallbackNickAttempted) {
      fallbackNickAttempted = true;
      const fallbackNick = buildFallbackNick(desiredNick);
      if (fallbackNick.toLowerCase() !== currentNick.toLowerCase()) {
        try {
          sendRaw(`NICK ${fallbackNick}`);
          currentNick = fallbackNick;
          return true;
        } catch (err) {
          fail(err);
        }
      }
    }
    return false;
  };

  const join = (channel: string) => {
    const target = sanitizeIrcTarget(channel);
    if (!target.startsWith("#") && !target.startsWith("&")) {
      throw new Error(`IRC JOIN target must be a channel: ${channel}`);
    }
    sendRaw(`JOIN ${target}`);
  };

  const sendPrivmsg = (target: string, text: string) => {
    const normalizedTarget = sanitizeIrcTarget(target);
    const cleaned = sanitizeIrcOutboundText(text);
    if (!cleaned) {
      return;
    }

    const hasNewlines = cleaned.includes("\n");

    if (multilineCap && hasNewlines) {
      // Use BATCH for multiline messages
      // trim() removes trailing newlines but preserves blank lines in the middle (paragraph breaks)
      const lines = cleaned.trim().split("\n");
      batchCounter++;
      const batchId = `m${batchCounter}`;
      sendRaw(`BATCH +${batchId} draft/multiline ${normalizedTarget}`);
      for (const line of lines) {
        socket.write(`@batch=${batchId} PRIVMSG ${normalizedTarget} :${line}\r\n`);
      }
      sendRaw(`BATCH -${batchId}`);
    } else {
      // Single line or no multiline support - flatten newlines
      socket.write(`PRIVMSG ${normalizedTarget} :${cleaned.replace(/\n/g, " ")}\r\n`);
    }
  };

  const quit = (reason?: string) => {
    if (closed) {
      return;
    }
    closed = true;
    const safeReason = sanitizeIrcOutboundText(reason != null ? reason : "bye");
    try {
      if (safeReason) {
        sendRaw(`QUIT :${safeReason}`);
      } else {
        sendRaw("QUIT");
      }
    } catch {
      // Ignore quit failures while shutting down.
    }
    socket.end();
  };

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    socket.destroy();
  };

  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const rawLine = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");

      if (!rawLine) {
        continue;
      }
      if (options.onLine) {
        options.onLine(rawLine);
      }

      const line = parseIrcLine(rawLine);
      if (!line) {
        continue;
      }

      if (line.command === "PING") {
        const payload =
          line.trailing != null ? line.trailing : line.params[0] != null ? line.params[0] : "";
        sendRaw(`PONG :${payload}`);
        continue;
      }

      // CAP negotiation for draft/multiline
      if (line.command === "CAP" && line.params[1] === "LS") {
        // Accumulate caps from each chunk
        accumulatedCaps += " " + (line.trailing ?? "").toLowerCase();
        // params[2] === "*" means more chunks coming; wait for final chunk
        if (line.params[2] === "*") {
          continue;
        }
        // Final chunk - process accumulated caps
        if (accumulatedCaps.includes("draft/multiline")) {
          sendRaw(`CAP REQ draft/multiline`);
        } else {
          resolveCapComplete?.();
          sendRaw(`CAP END`);
        }
        continue;
      }

      if (line.command === "CAP" && line.params[1] === "ACK") {
        // Capability can be in trailing OR in params[2] depending on server
        const acked = ((line.trailing ?? line.params[2] ?? "") as string).toLowerCase();
        if (acked.includes("draft/multiline")) {
          multilineCap = true;
        }
        resolveCapComplete?.();
        sendRaw(`CAP END`);
        continue;
      }

      if (line.command === "CAP" && line.params[1] === "NAK") {
        // Server rejected our CAP request, end negotiation
        resolveCapComplete?.();
        sendRaw(`CAP END`);
        continue;
      }

      if (line.command === "NICK") {
        const prefix = parseIrcPrefix(line.prefix);
        if (prefix.nick && prefix.nick.toLowerCase() === currentNick.toLowerCase()) {
          const next =
            line.trailing != null
              ? line.trailing
              : line.params[0] != null
                ? line.params[0]
                : currentNick;
          currentNick = String(next).trim();
        }
        continue;
      }

      if (!ready && IRC_NICK_COLLISION_CODES.has(line.command)) {
        if (tryRecoverNickCollision()) {
          continue;
        }
        const detail =
          line.trailing != null ? line.trailing : line.params.join(" ") || "nickname in use";
        fail(new Error(`IRC login failed (${line.command}): ${detail}`));
        close();
        return;
      }

      if (!ready && IRC_ERROR_CODES.has(line.command)) {
        const detail =
          line.trailing != null ? line.trailing : line.params.join(" ") || "login rejected";
        fail(new Error(`IRC login failed (${line.command}): ${detail}`));
        close();
        return;
      }

      if (line.command === "001") {
        ready = true;
        // Fallback: if CAP negotiation didn't complete, resolve it now
        // (non-CAP servers won't respond to CAP LS)
        resolveCapComplete?.();
        const nickParam = line.params[0];
        if (nickParam && nickParam.trim()) {
          currentNick = nickParam.trim();
        }
        try {
          const nickServCommands = buildIrcNickServCommands(options.nickserv);
          for (const command of nickServCommands) {
            sendRaw(command);
          }
        } catch (err) {
          fail(err);
        }
        for (const channel of options.channels || []) {
          const trimmed = channel.trim();
          if (!trimmed) {
            continue;
          }
          try {
            join(trimmed);
          } catch (err) {
            fail(err);
          }
        }
        if (resolveReady) {
          resolveReady();
        }
        resolveReady = null;
        rejectReady = null;
        continue;
      }

      if (line.command === "NOTICE") {
        if (options.onNotice) {
          options.onNotice(line.trailing != null ? line.trailing : "", line.params[0]);
        }
        continue;
      }

      // Handle BATCH commands for draft/multiline
      if (line.command === "BATCH") {
        const batchParam = line.params[0] || line.trailing;
        if (!batchParam) continue;

        if (batchParam.startsWith("+")) {
          // Start of batch - just initialize the buffer
          const batchId = batchParam.slice(1);
          incomingBatches.set(batchId, []);
        } else if (batchParam.startsWith("-")) {
          // End of batch - combine and emit
          const batchId = batchParam.slice(1);
          const messages = incomingBatches.get(batchId);
          incomingBatches.delete(batchId);

          if (messages && messages.length > 0 && options.onPrivmsg) {
            // Combine all messages in the batch
            const first = messages[0];
            const combinedText = messages.map(m => m.text).join("\n");
            void Promise.resolve(
              options.onPrivmsg({
                senderNick: first.senderNick,
                senderUser: first.senderUser,
                senderHost: first.senderHost,
                target: first.target,
                text: combinedText,
                rawLine: `[BATCH ${batchId}]`, // Indicate this was a batch
              }),
            ).catch((error) => {
              fail(error);
            });
          }
        }
        continue;
      }

      if (line.command === "PRIVMSG") {
        const targetParam = line.params[0];
        const target = targetParam ? targetParam.trim() : "";
        const text = line.trailing != null ? line.trailing : "";
        const prefix = parseIrcPrefix(line.prefix);
        const senderNick = prefix.nick ? prefix.nick.trim() : "";
        if (!target || !senderNick || !text.trim()) {
          continue;
        }

        // Check if this message is part of a batch
        const batchTag = line.tags?.get("batch");
        if (batchTag) {
          // Buffer the message for later
          const batch = incomingBatches.get(batchTag);
          if (batch) {
            batch.push({
              senderNick,
              senderUser: prefix.user ? prefix.user.trim() : undefined,
              senderHost: prefix.host ? prefix.host.trim() : undefined,
              target,
              text,
            });
          }
          continue; // Don't emit yet - wait for BATCH -<id>
        }

        if (options.onPrivmsg) {
          void Promise.resolve(
            options.onPrivmsg({
              senderNick,
              senderUser: prefix.user ? prefix.user.trim() : undefined,
              senderHost: prefix.host ? prefix.host.trim() : undefined,
              target,
              text,
              rawLine,
            }),
          ).catch((error) => {
            fail(error);
          });
        }
      }
    }
  });

  socket.once("connect", () => {
    try {
      // Start CAP negotiation for draft/multiline support
      sendRaw(`CAP LS 302`);
      if (options.password && options.password.trim()) {
        sendRaw(`PASS ${options.password.trim()}`);
      }
      sendRaw(`NICK ${options.nick.trim()}`);
      sendRaw(`USER ${options.username.trim()} 0 * :${sanitizeIrcOutboundText(options.realname)}`);
    } catch (err) {
      fail(err);
      close();
    }
  });

  socket.once("error", (err: unknown) => {
    fail(err);
  });

  socket.once("close", () => {
    if (!closed) {
      closed = true;
      if (!ready) {
        fail(new Error("IRC connection closed before ready"));
      }
    }
  });

  if (options.abortSignal) {
    const abort = () => {
      quit("shutdown");
    };
    if (options.abortSignal.aborted) {
      abort();
    } else {
      options.abortSignal.addEventListener("abort", abort, { once: true });
    }
  }

  await withTimeout(readyPromise, timeoutMs, "IRC connect");
  // Also wait for CAP negotiation to complete (multiline support)
  await withTimeout(capCompletePromise, 5000, "IRC CAP negotiation");

  return {
    get nick() {
      return currentNick;
    },
    isReady: () => ready && !closed,
    sendRaw,
    join,
    sendPrivmsg,
    quit,
    close,
  };
}
