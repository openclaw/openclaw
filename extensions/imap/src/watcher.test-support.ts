import { EventEmitter } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { authenticate } from "mailauth";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginServiceContextV2 } from "openclaw/plugin-sdk/plugin-entry";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { afterEach, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { resolveImapConfig, type ImapAccountConfig } from "./config.js";
import { createImapAuthResult, createImapTestRuntime } from "./imap-test-support.js";
import type { ImapCursor } from "./state.js";
import { ImapAccountWatcher } from "./watcher.js";

vi.mock("mailauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mailauth")>();
  return { ...actual, authenticate: vi.fn(actual.authenticate) };
});

type MailFixture = { uid: number; raw: string; reportedSize?: number };

export class ScriptedImapServer {
  readonly sockets = new Set<Socket>();
  readonly commands: string[] = [];
  readonly messages: MailFixture[] = [];
  uidValidity = "17";
  connectionCount = 0;
  rejectAuthentication = false;
  omitUidNext = false;
  beforeSequenceFetch: (() => void) | undefined;
  sequenceFetchGate: Promise<void> | undefined;
  sequenceUidOverride: number | undefined;
  fetchGate: Promise<void> | undefined;
  fetchedBodies = 0;
  private readonly server: Server;
  private readonly commandEvents = new EventEmitter();

  constructor(private readonly supportsIdle = true) {
    this.server = createServer((socket) => {
      this.accept(socket);
    });
  }

  async listen(): Promise<number> {
    return await listenOnLoopback(this.server);
  }

  async waitForCommand(match: (command: string) => boolean): Promise<string> {
    const command = this.commands.find(match);
    if (command) {
      return command;
    }
    return new Promise((resolve) => {
      const onCommand = (next: string) => {
        if (match(next)) {
          this.commandEvents.off("command", onCommand);
          resolve(next);
        }
      };
      this.commandEvents.on("command", onCommand);
    });
  }

  append(raw: string): void {
    const uid = (this.messages.at(-1)?.uid ?? 0) + 1;
    this.messages.push({ uid, raw });
    this.announce();
  }

  announce(): void {
    for (const socket of this.sockets) {
      socket.write(`* ${this.messages.length} EXISTS\r\n`);
    }
  }

  disconnect(): void {
    for (const socket of this.sockets) {
      socket.destroy();
    }
  }

  async close(): Promise<void> {
    this.disconnect();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private accept(socket: Socket): void {
    this.connectionCount++;
    this.sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => this.sockets.delete(socket));
    const capabilities = `IMAP4rev1${this.supportsIdle ? " IDLE" : ""}`;
    socket.write(`* OK [CAPABILITY ${capabilities}] scripted IMAP ready\r\n`);
    let buffered = "";
    let idleTag: string | undefined;
    socket.on("data", (data: Buffer) => {
      buffered += data.toString("utf8");
      let separator: number;
      while ((separator = buffered.indexOf("\r\n")) >= 0) {
        const line = buffered.slice(0, separator);
        buffered = buffered.slice(separator + 2);
        this.commands.push(line);
        this.commandEvents.emit("command", line);
        if (line === "DONE" && idleTag) {
          socket.write(`${idleTag} OK IDLE completed\r\n`);
          idleTag = undefined;
          continue;
        }
        const [tag, command, subcommand] = line.split(" ");
        const upper = command?.toUpperCase();
        if (upper === "CAPABILITY") {
          socket.write(`* CAPABILITY ${capabilities}\r\n${tag} OK CAPABILITY completed\r\n`);
        } else if (upper === "LOGIN") {
          socket.write(
            this.rejectAuthentication
              ? `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`
              : `${tag} OK LOGIN completed\r\n`,
          );
        } else if (upper === "LIST" || upper === "LSUB") {
          socket.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK LIST completed\r\n`);
        } else if (upper === "EXAMINE" || upper === "SELECT") {
          const uidNext = this.omitUidNext
            ? ""
            : `* OK [UIDNEXT ${(this.messages.at(-1)?.uid ?? 0) + 1}] next\r\n`;
          socket.write(
            `* FLAGS (\\Seen)\r\n* ${this.messages.length} EXISTS\r\n* OK [UIDVALIDITY ${this.uidValidity}] valid\r\n${uidNext}${tag} OK [READ-ONLY] opened\r\n`,
          );
        } else if (upper === "IDLE") {
          idleTag = tag;
          socket.write("+ idling\r\n");
        } else if (
          upper === "FETCH" ||
          (upper === "UID" && subcommand?.toUpperCase() === "FETCH")
        ) {
          const usesUid = upper === "UID";
          if (!usesUid) {
            this.beforeSequenceFetch?.();
          }
          const last = usesUid ? (this.messages.at(-1)?.uid ?? 0) : this.messages.length;
          const ranges = (line.split(" ")[usesUid ? 3 : 2] ?? "").split(",").map((range) => {
            const bounds = range.split(":").map((bound) => (bound === "*" ? last : Number(bound)));
            return [Math.min(...bounds), Math.max(...bounds)] as const;
          });
          // Snapshot the response at command time: a held response must not absorb
          // messages appended while the fetch is in flight.
          const matches = this.messages
            .map((mail, index) => ({ ...mail, sequence: index + 1 }))
            .filter((entry) => {
              const value = usesUid ? entry.uid : entry.sequence;
              return ranges.some(([minimum, maximum]) => value >= minimum && value <= maximum);
            });
          const respond = () => {
            for (const mail of matches) {
              const wantsBody = line.includes("BODY");
              if (wantsBody && mail.uid > 1) {
                this.fetchedBodies++;
              }
              const date = new Date()
                .toUTCString()
                .slice(5)
                .replace(/ /u, "-")
                .replace(/ /u, "-")
                .replace(" GMT", " +0000");
              socket.write(
                wantsBody
                  ? `* ${mail.sequence} FETCH (UID ${mail.uid} INTERNALDATE "${date}" RFC822.SIZE ${mail.reportedSize ?? Buffer.byteLength(mail.raw)} BODY[]<0> {${Buffer.byteLength(mail.raw)}}\r\n${mail.raw})\r\n`
                  : `* ${mail.sequence} FETCH (UID ${!usesUid && this.sequenceUidOverride !== undefined ? this.sequenceUidOverride : mail.uid})\r\n`,
              );
            }
            socket.write(`${tag} OK FETCH completed\r\n`);
          };
          const gate = usesUid ? this.fetchGate : this.sequenceFetchGate;
          if (gate) {
            void gate.then(respond);
          } else {
            respond();
          }
        } else {
          socket.write(`${tag} OK completed\r\n`);
        }
      }
    });
  }
}

const activeServers: ScriptedImapServer[] = [];
const activeWatchers: ImapAccountWatcher[] = [];

export function existingMail(uids = [101, 505, 9007]): MailFixture[] {
  return uids.map((uid) => ({
    uid,
    raw: `From: trusted@example.com\r\nSubject: Existing ${uid}\r\n\r\nExisting email`,
  }));
}

export const isBaselineFetch = (command: string) => /^[^ ]+ FETCH (?:\*|\d+) UID$/u.test(command);

afterEach(async () => {
  await Promise.all(activeWatchers.splice(0).map((watcher) => watcher.stop()));
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
  vi.mocked(authenticate).mockReset();
});

export async function startWatcher(
  options: {
    supportsIdle?: boolean;
    rejectAuthentication?: boolean;
    omitUidNext?: boolean;
    messages?: MailFixture[];
    cursor?: ImapCursor;
    configureServer?: (server: ScriptedImapServer) => void;
    waitForStartup?: boolean;
    account?: Partial<ImapAccountConfig>;
    clock?: ReturnType<typeof createGatewaySchedulerClock>;
  } = {},
) {
  const server = new ScriptedImapServer(options.supportsIdle);
  server.rejectAuthentication = options.rejectAuthentication ?? false;
  server.omitUidNext = options.omitUidNext ?? false;
  activeServers.push(server);
  server.messages.push(
    ...(options.messages ?? [
      { uid: 1, raw: "From: trusted@example.com\r\nSubject: Existing\r\n\r\nExisting email" },
    ]),
  );
  options.configureServer?.(server);
  const port = await server.listen();
  const account = resolveImapConfig({
    accounts: {
      inbox: {
        host: "127.0.0.1",
        port,
        secure: false,
        user: "reader@example.com",
        password: "fixture-password",
        agentId: "mail_reader",
        allowedSenders: ["trusted@example.com"],
      },
    },
  }).accounts.inbox;
  if (!account) {
    throw new Error("fixture account was not configured");
  }
  Object.assign(account, options.account);
  const {
    runtime,
    state,
    dispatchHookAgentTurn,
    waitForCursor: waitForAccountCursor,
  } = createImapTestRuntime();
  if (options.cursor) {
    await state.cursors.register("inbox", options.cursor);
  }
  const waitForCursor = (
    lastSeenUid: number,
    timeoutMs = 1_000,
    uidValidity = server.uidValidity,
  ) =>
    withTimeout(waitForAccountCursor("inbox", { uidValidity, lastSeenUid }), timeoutMs, {
      message: `IMAP inbox cursor did not reach UIDVALIDITY ${uidValidity}, UID ${lastSeenUid}`,
    });
  const { promise: startup, resolve: resolveStartup } = createDeferred<void>();
  const { promise: connectionFailure, resolve: resolveFailure } = createDeferred<unknown>();
  const context: OpenClawPluginServiceContextV2 = {
    scheduler: createTestPluginServiceScheduler(
      options.clock ? createTestGatewayScheduler(options.clock.clock) : undefined,
    ),
    config: {},
    stateDir: "/unused-imap-test-state",
    logger: {
      info: vi.fn((message: string) => {
        if (message.startsWith("imap: account=inbox mode=")) {
          resolveStartup();
        }
      }),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    serviceHealth: { clearFailure: vi.fn(), reportFailure: vi.fn(resolveFailure) },
  };
  const authenticator = vi.mocked(authenticate).mockResolvedValue(createImapAuthResult("pass"));
  const watcher = new ImapAccountWatcher({
    accountId: "inbox",
    account,
    runtime,
    state,
    context,
    // Exercise real reconnects without waiting through production backoff intervals.
    reconnectBaseMs: 5,
  });
  activeWatchers.push(watcher);
  watcher.start();
  void options.clock?.wake();
  // start() is fire-and-forget; observe the committed baseline before driving mail.
  // Authentication-failure tests intentionally never reach cursor registration.
  if (!options.rejectAuthentication && options.waitForStartup !== false) {
    await Promise.race([
      startup,
      connectionFailure.then((error) => {
        throw error;
      }),
    ]);
  }
  return {
    server,
    watcher,
    state,
    context,
    authenticator,
    dispatchHookAgentTurn,
    waitForCursor,
    startup,
    connectionFailure,
  };
}
