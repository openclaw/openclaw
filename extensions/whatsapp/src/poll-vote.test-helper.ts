// Test support for WhatsApp poll votes: client-side vote encryption and a real plugin-state runtime.
import { createHash, randomBytes } from "node:crypto";
import { aesEncryptGCM, hmacSign, proto } from "baileys";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  closeOpenClawStateDatabaseForTest,
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { vi } from "vitest";
import { setWhatsAppRuntime } from "./runtime.js";

export function hashWhatsAppPollOptionForTest(option: string): Buffer {
  return createHash("sha256").update(Buffer.from(option)).digest();
}

/** Encrypts a vote exactly as a WhatsApp client does; the inverse of Baileys decryptPollVote. */
export function encryptWhatsAppPollVoteForTest(params: {
  secret: Uint8Array;
  pollMsgId: string;
  pollCreatorJid: string;
  voterJid: string;
  selectedOptions: string[];
  selectedHashes?: Uint8Array[];
}): { encPayload: Buffer; encIv: Buffer } {
  const sign = Buffer.concat([
    Buffer.from(params.pollMsgId),
    Buffer.from(params.pollCreatorJid),
    Buffer.from(params.voterJid),
    Buffer.from("Poll Vote"),
    new Uint8Array([1]),
  ]);
  const key0 = hmacSign(params.secret, new Uint8Array(32), "sha256");
  const encKey = hmacSign(sign, key0, "sha256");
  const encIv = randomBytes(12);
  const aad = Buffer.from(`${params.pollMsgId}\u0000${params.voterJid}`);
  const plaintext = proto.Message.PollVoteMessage.encode({
    selectedOptions:
      params.selectedHashes ?? params.selectedOptions.map(hashWhatsAppPollOptionForTest),
  }).finish();
  return { encPayload: aesEncryptGCM(plaintext, encKey, encIv, aad), encIv };
}

/** A messages.upsert vote as Baileys delivers it: pollUpdateMessage with the encrypted selection. */
export function buildWhatsAppPollVoteMessageForTest(params: {
  id: string;
  remoteJid: string;
  participant?: string;
  fromMe?: boolean;
  pushName?: string;
  pollMsgId: string;
  pollCreatorJid: string;
  voterJid: string;
  secret: Uint8Array;
  selectedOptions: string[];
  selectedHashes?: Uint8Array[];
  senderTimestampMs?: number;
}) {
  return {
    key: {
      id: params.id,
      remoteJid: params.remoteJid,
      fromMe: params.fromMe ?? false,
      ...(params.participant ? { participant: params.participant } : {}),
    },
    message: {
      pollUpdateMessage: {
        pollCreationMessageKey: { id: params.pollMsgId, remoteJid: params.remoteJid },
        vote: encryptWhatsAppPollVoteForTest(params),
        senderTimestampMs: params.senderTimestampMs ?? Date.now(),
      },
    },
    messageTimestamp: Math.floor((params.senderTimestampMs ?? Date.now()) / 1000),
    ...(params.pushName ? { pushName: params.pushName } : {}),
  };
}

export type WhatsAppPollStoreFault = {
  namespace: string;
  method: "lookup" | "register" | "registerIfAbsent" | "delete" | "entriesInKeyRange";
  /** Pass the full PLUGIN_STATE_* code, or undefined for an Error without a code. */
  code: string | undefined;
  /** Fire on the first matching call only. */
  once?: boolean;
};

export function createWhatsAppPollStoreFaultError(code: string | undefined): Error {
  return Object.assign(new Error("injected plugin state failure"), code ? { code } : {});
}

/**
 * The real plugin-state SQLite store in a temp state dir. Faults wrap single
 * methods and are the only fakes allowed.
 */
export async function createWhatsAppPollStateForTest() {
  closeOpenClawStateDatabaseForTest();
  const state = await createOpenClawTestState({
    label: "whatsapp-poll-votes",
    layout: "state-only",
  });
  const faults: WhatsAppPollStoreFault[] = [];
  const opened = new Set<string>();
  const openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions): PluginStateKeyedStore<T> => {
    opened.add(options.namespace);
    const store = createPluginStateKeyedStoreForTests<T>("whatsapp", {
      ...options,
      env: state.env,
    });
    const fault = (method: WhatsAppPollStoreFault["method"]) => {
      const match = faults.find(
        (entry) => entry.namespace === options.namespace && entry.method === method,
      );
      if (match) {
        if (match.once) {
          faults.splice(faults.indexOf(match), 1);
        }
        throw createWhatsAppPollStoreFaultError(match.code);
      }
    };
    return {
      ...store,
      async lookup(key) {
        fault("lookup");
        return await store.lookup(key);
      },
      async register(key, value, opts) {
        fault("register");
        await store.register(key, value, opts);
      },
      async registerIfAbsent(key, value, opts) {
        fault("registerIfAbsent");
        return await store.registerIfAbsent(key, value, opts);
      },
      async delete(key, opts) {
        fault("delete");
        return await store.delete(key, opts);
      },
      async entriesInKeyRange(range) {
        fault("entriesInKeyRange");
        return await store.entriesInKeyRange(range);
      },
    };
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    env: state.env,
    faults,
    logger,
    opened,
    openKeyedStore,
    /** Direct access to one namespace of the same real store, for assertions. */
    openStore<T>(options: OpenAsyncKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("whatsapp", { ...options, env: state.env });
    },
    async cleanup() {
      resetPluginStateStoreForTests();
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
    },
  };
}

/** Installs a WhatsApp runtime whose keyed stores are the real store above. */
export async function installWhatsAppPollStateRuntimeForTest() {
  const pollState = await createWhatsAppPollStateForTest();
  const runtime = createPluginRuntimeMock({ state: { openKeyedStore: pollState.openKeyedStore } });
  vi.spyOn(runtime.logging, "getChildLogger").mockReturnValue(
    pollState.logger as unknown as ReturnType<typeof runtime.logging.getChildLogger>,
  );
  setWhatsAppRuntime(runtime);
  return { ...pollState, runtime };
}

export type WhatsAppPollStateRuntimeForTest = Awaited<
  ReturnType<typeof installWhatsAppPollStateRuntimeForTest>
>;
