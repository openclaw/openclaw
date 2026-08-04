// Nextcloud Talk tests cover room-kind lookup retry behavior at the inbound boundary.
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";

type ProofServer = {
  baseUrl: string;
  requests: string[];
  stop: () => Promise<void>;
};

const servers: ProofServer[] = [];

async function startRoomInfoServer(): Promise<ProofServer> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    if (requests.length === 1) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("temporary outage");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ocs: { data: { type: 1 } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback listener address");
  }
  const proofServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    stop: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
  servers.push(proofServer);
  return proofServer;
}

function installRuntime(dispatches: { count: number }): void {
  setNextcloudTalkRuntime({
    channel: {
      inbound: {
        dispatch: async () => {
          dispatches.count += 1;
        },
      },
      pairing: {
        readAllowFromStore: async () => [],
        upsertPairingRequest: async () => ({ code: "123456", created: true }),
      },
      commands: {
        shouldHandleTextCommands: () => false,
      },
      text: {
        hasControlCommand: () => false,
      },
      mentions: {
        buildMentionRegexes: () => [],
        matchesMentionPatterns: () => false,
      },
    },
  } as never);
}

function createAccount(baseUrl: string): ResolvedNextcloudTalkAccount {
  return {
    accountId: "proof",
    enabled: true,
    baseUrl,
    secret: "bot-secret",
    secretSource: "config",
    config: {
      apiUser: "bot",
      apiPassword: "secret",
      dmPolicy: "allowlist",
      allowFrom: ["user-1"],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
      network: { dangerouslyAllowPrivateNetwork: true },
    },
  };
}

function createMessage(): NextcloudTalkInboundMessage {
  return {
    messageId: "msg-proof",
    roomToken: "room-direct",
    roomName: "Direct room",
    senderId: "user-1",
    senderName: "Alice",
    text: "hello",
    mediaType: "text/plain",
    timestamp: 1_800_000_000_000,
    // Durable Activity Streams replay rows carry no room kind; runtime lookup must refine it.
    isGroupChat: true,
  };
}

afterEach(async () => {
  const pending = servers.splice(0);
  await Promise.all(pending.map((server) => server.stop()));
});

describe("nextcloud-talk inbound room-kind lookup retry", () => {
  it("defers lookup failures and dispatches the recovered direct room on retry", async () => {
    const server = await startRoomInfoServer();
    const dispatches = { count: 0 };
    const logs: string[] = [];
    const deferred: string[] = [];
    installRuntime(dispatches);
    const lifecycle = {
      abortSignal: new AbortController().signal,
      onAdopted: async () => {},
      onDeferred: () => deferred.push("first"),
      onAdoptionFinalizing: () => {},
      onAbandoned: async () => {},
    };
    const runtime: RuntimeEnv = {
      log: (messageValue) => logs.push(messageValue),
      error: (messageValue) => logs.push(messageValue),
    } as RuntimeEnv;

    await handleNextcloudTalkInbound({
      message: createMessage(),
      account: createAccount(server.baseUrl),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime,
      turnAdoptionLifecycle: lifecycle,
    });
    await handleNextcloudTalkInbound({
      message: createMessage(),
      account: createAccount(server.baseUrl),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime,
      turnAdoptionLifecycle: {
        ...lifecycle,
        onDeferred: () => deferred.push("second"),
      },
    });

    expect(deferred).toEqual(["first"]);
    expect(dispatches.count).toBe(1);
    expect(server.requests).toHaveLength(2);
    expect(logs).toContain("nextcloud-talk: defer room room-direct until room lookup recovers");
  });
});
