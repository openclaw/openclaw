import net from "node:net";
import tls from "node:tls";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withTimeout } from "openclaw/plugin-sdk/security-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  parseIrcLine,
  parseIrcPrefix,
  sanitizeIrcOutboundText,
  sanitizeIrcTarget,
} from "./protocol.js";

const IRC_ERROR_CODES = new Set(["432", "464", "465"]);
const IRC_NICK_COLLISION_CODES = new Set(["433", "436"]);
const IRC_MAX_LINE_BYTES = 512;
const MAX_UTF8_CODE_POINT_BYTES = 4;
// Recipients see our line prefixed by the server's `:nick!user@host `, and that relayed
// line is bounded by 512 bytes too. Reserve the relay prefix's worst case (`~` + USERLEN
// 10, HOSTLEN 63) so carried whitespace cannot combine into a chunk a server truncates.
const IRC_MAX_RELAY_USER_BYTES = 11;
const IRC_MAX_RELAY_HOST_BYTES = 63;

function takeIrcWhitespacePrefix(whitespace: string, maxBytes: number): string {
  let prefix = "";
  let bytes = 0;
  for (const codePoint of whitespace) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + codePointBytes > maxBytes) {
      break;
    }
    prefix += codePoint;
    bytes += codePointBytes;
  }
  return prefix;
}

function takeIrcPrivmsgChunk(text: string, maxChars: number, maxBytes: number): string {
  let end = 0;
  let bytes = 0;
  for (const codePoint of text) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    const exceedsCharCap = end > 0 && end + codePoint.length > maxChars;
    if (exceedsCharCap || bytes + codePointBytes > maxBytes) {
      break;
    }
    end += codePoint.length;
    bytes += codePointBytes;
  }
  if (end === 0) {
    throw new Error("IRC target leaves no room for message text within the 512-byte line limit");
  }
  if (end === text.length) {
    return text;
  }
  const fitted = text.slice(0, end);
  // A delimiter just beyond the cap already gives this chunk a clean word boundary.
  if (text[end] === " ") {
    return fitted;
  }
  const splitAt = fitted.lastIndexOf(" ");
  if (splitAt > 0 && splitAt >= Math.floor(fitted.length / 2)) {
    return fitted.slice(0, splitAt);
  }
  return fitted;
}

type IrcPrivmsgEvent = {
  senderNick: string;
  connectedNick: string;
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
  onDisconnect?: () => void;
  onLine?: (line: string) => void;
};

type IrcNickServOptions = {
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
  sendPrivmsg: (target: string, text: string, replyTo?: string) => void;
  quit: (reason?: string) => void;
  close: () => void;
};

function toIrcError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  return new Error(typeof err === "string" ? err : JSON.stringify(err));
}

let nickCollisionFallbackSeq = 0;

function buildFallbackNick(nick: string): string {
  const normalized = nick.replace(/\s+/g, "");
  const safe = normalized.replace(/[^A-Za-z0-9_\-[\]\\`^{}|]/g, "");
  const base = safe || "openclaw";
  const seq = ++nickCollisionFallbackSeq;
  const suffix = seq === 1 ? "_" : `_${seq}`;
  const maxNickLen = 30;
  if (base.length >= maxNickLen) {
    return `${base.slice(0, maxNickLen - suffix.length)}${suffix}`;
  }
  return `${base}${suffix}`;
}

function buildIrcNickServCommands(options?: IrcNickServOptions): string[] {
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
  const timeoutMs = options.connectTimeoutMs ?? 15000;
  const messageChunkMaxChars = Math.max(1, Math.floor(options.messageChunkMaxChars ?? 350));

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
  let removeAbortListener: (() => void) | null = null;

  const socket = options.tls
    ? tls.connect({
        host: options.host,
        port: options.port,
        servername: options.host,
      })
    : net.connect({ host: options.host, port: options.port });

  socket.setEncoding("utf8");

  const readyDeferred = createDeferred<void>();

  const fail = (err: unknown) => {
    const error = toIrcError(err);
    options.onError?.(error);
    if (!ready) {
      readyDeferred.reject(error);
    }
  };

  const failAndClose = (err: unknown) => {
    fail(err);
    close();
  };

  const sendRaw = (line: string) => {
    const cleaned = line.replace(/[\r\n]+/g, "").trim();
    if (!cleaned) {
      throw new Error("IRC command cannot be empty");
    }
    socket.write(`${cleaned}\r\n`);
  };

  const sendRawPreservingWhitespace = (line: string) => {
    const cleaned = line.replace(/[\r\n]+/g, "");
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
      if (
        normalizeLowercaseStringOrEmpty(fallbackNick) !==
        normalizeLowercaseStringOrEmpty(currentNick)
      ) {
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

  const sendPrivmsg = (target: string, text: string, replyTo?: string) => {
    const normalizedTarget = sanitizeIrcTarget(target);
    const cleaned = sanitizeIrcOutboundText(text);
    if (!cleaned) {
      throw new Error("Message must be non-empty for IRC sends");
    }
    const relayPrefixBytes =
      Buffer.byteLength(`:${currentNick}!@ `, "utf8") +
      IRC_MAX_RELAY_USER_BYTES +
      IRC_MAX_RELAY_HOST_BYTES;
    const lineOverheadBytes =
      relayPrefixBytes + Buffer.byteLength(`PRIVMSG ${normalizedTarget} :\r\n`, "utf8");
    const maxChunkBytes = IRC_MAX_LINE_BYTES - lineOverheadBytes;
    // Encode the original text with the reference so escapes are not decoded twice.
    let remaining = replyTo ? sanitizeIrcOutboundText(`${text}\n\n[reply:${replyTo}]`) : cleaned;
    let pendingWhitespace = "";
    while (remaining.length > 0) {
      // Slice by the trimmed length so whitespace trimmed off a chunk's tail
      // stays in `remaining` as the next chunk's leading space. Trimming both
      // sides used to drop separator spaces between chunks, collapsing runs of
      // spaces in the delivered message.
      const pendingBytes = Buffer.byteLength(pendingWhitespace, "utf8");
      const chunk = takeIrcPrivmsgChunk(
        remaining,
        messageChunkMaxChars,
        maxChunkBytes - pendingBytes,
      );
      const trimmed = chunk.trimEnd();
      if (trimmed.length > 0) {
        sendRaw(`PRIVMSG ${normalizedTarget} :${pendingWhitespace}${trimmed}`);
        pendingWhitespace = "";
        remaining = remaining.slice(trimmed.length);
      } else {
        // A chunk made of only whitespace preserves an interior space run:
        // carry it forward as the leading space of the next non-empty chunk
        // instead of sending an empty PRIVMSG, and guarantee progress. Cap the
        // carried run to the line budget so a run longer than one line cannot
        // overflow the 512-byte IRC limit, and emit the overflow as its own
        // whitespace-only lines so no sanitized bytes are dropped.
        const carryBudget = maxChunkBytes - pendingBytes - MAX_UTF8_CODE_POINT_BYTES;
        const carried = carryBudget > 0 ? takeIrcWhitespacePrefix(chunk, carryBudget) : "";
        pendingWhitespace += carried;
        remaining = remaining.slice(chunk.length);
        let overflow = chunk.slice(carried.length);
        if (overflow.length > 0) {
          // Flush the buffered prefix before its overflow so a mixed-whitespace
          // run (e.g. nonbreaking spaces plus ASCII spaces) keeps its original
          // order across the byte-bounded wire lines.
          overflow = pendingWhitespace + overflow;
          pendingWhitespace = "";
        }
        while (overflow.length > 0) {
          const wsChunk = takeIrcPrivmsgChunk(overflow, messageChunkMaxChars, maxChunkBytes);
          sendRawPreservingWhitespace(`PRIVMSG ${normalizedTarget} :${wsChunk}`);
          overflow = overflow.slice(wsChunk.length);
        }
      }
    }
  };

  const quit = (reason?: string) => {
    if (closed) {
      return;
    }
    closed = true;
    removeAbortListener?.();
    removeAbortListener = null;
    const safeReason = sanitizeIrcOutboundText(reason ?? "bye");
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
    removeAbortListener?.();
    removeAbortListener = null;
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
      options.onLine?.(rawLine);

      const line = parseIrcLine(rawLine);
      if (!line) {
        continue;
      }

      if (line.command === "PING") {
        const payload = line.trailing ?? line.params[0] ?? "";
        sendRaw(`PONG :${payload}`);
        continue;
      }

      if (line.command === "NICK") {
        const prefix = parseIrcPrefix(line.prefix);
        if (
          prefix.nick &&
          normalizeLowercaseStringOrEmpty(prefix.nick) ===
            normalizeLowercaseStringOrEmpty(currentNick)
        ) {
          currentNick = (line.trailing ?? line.params[0] ?? currentNick).trim();
        }
        continue;
      }

      const nickCollision = IRC_NICK_COLLISION_CODES.has(line.command);
      if (!ready && (nickCollision || IRC_ERROR_CODES.has(line.command))) {
        if (nickCollision && tryRecoverNickCollision()) {
          continue;
        }
        const detail =
          line.trailing ??
          (line.params.join(" ") || (nickCollision ? "nickname in use" : "login rejected"));
        failAndClose(new Error(`IRC login failed (${line.command}): ${detail}`));
        return;
      }

      if (line.command === "001") {
        ready = true;
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
        readyDeferred.resolve();
        continue;
      }

      if (line.command === "NOTICE") {
        options.onNotice?.(line.trailing ?? "", line.params[0]);
        continue;
      }

      if (line.command === "PRIVMSG") {
        const targetParam = line.params[0];
        const target = targetParam?.trim() ?? "";
        const text = line.trailing ?? line.params[1] ?? "";
        const prefix = parseIrcPrefix(line.prefix);
        const senderNick = prefix.nick?.trim() ?? "";
        if (!target || !senderNick || !text.trim()) {
          continue;
        }
        if (options.onPrivmsg) {
          void Promise.resolve(
            options.onPrivmsg({
              senderNick,
              connectedNick: currentNick,
              rawLine,
            }),
          ).catch((error: unknown) => {
            fail(error);
          });
        }
      }
    }
  });

  socket.once("connect", () => {
    try {
      if (options.password && options.password.trim()) {
        sendRaw(`PASS ${options.password.trim()}`);
      }
      sendRaw(`NICK ${options.nick.trim()}`);
      sendRaw(`USER ${options.username.trim()} 0 * :${sanitizeIrcOutboundText(options.realname)}`);
    } catch (err) {
      failAndClose(err);
    }
  });

  socket.once("error", (err: unknown) => {
    fail(err);
  });

  socket.once("close", () => {
    if (!closed) {
      closed = true;
      removeAbortListener?.();
      removeAbortListener = null;
      if (!ready) {
        fail(new Error("IRC connection closed before ready"));
      } else {
        options.onDisconnect?.();
      }
    }
  });

  if (options.abortSignal) {
    const abort = () => {
      if (!ready) {
        failAndClose(new Error("IRC connect aborted"));
        return;
      }
      quit("shutdown");
    };
    if (options.abortSignal.aborted) {
      abort();
    } else {
      options.abortSignal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () => options.abortSignal?.removeEventListener("abort", abort);
    }
  }

  try {
    await withTimeout(readyDeferred.promise, timeoutMs, "IRC connect");
  } catch (error) {
    close();
    throw error;
  }

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
