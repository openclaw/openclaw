// Logging an account out retires its poll state together with its credentials.
import fsSync from "node:fs";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { logoutWeb } from "./auth-store.js";
import {
  recordWhatsAppPoll,
  WHATSAPP_POLL_CHAT_INDEX_STORES,
  WHATSAPP_POLL_RECORD_STORES,
  WHATSAPP_POLL_TALLY_STORES,
  type WhatsAppPollAccount,
} from "./poll-vote-store.js";
import { applyWhatsAppPollVote } from "./poll-vote-tally-store.js";
import {
  installWhatsAppPollStateRuntimeForTest,
  type WhatsAppPollStateRuntimeForTest,
} from "./poll-vote.test-helper.js";
import * as runtimeModule from "./runtime.js";

const hoisted = vi.hoisted(() => ({ oauthDir: "/tmp/openclaw-wa-poll-retire-oauth" }));

vi.mock("./auth-store.runtime.js", () => ({
  resolveOAuthDir: () => hoisted.oauthDir,
}));

const GROUP = "120363000000000001@g.us";
const SELF = { jid: "15550001111@s.whatsapp.net" };
const ALL_STORES = [
  ...Object.values(WHATSAPP_POLL_RECORD_STORES),
  ...Object.values(WHATSAPP_POLL_CHAT_INDEX_STORES),
  ...Object.values(WHATSAPP_POLL_TALLY_STORES),
];

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let env: WhatsAppPollStateRuntimeForTest;

beforeEach(async () => {
  env = await installWhatsAppPollStateRuntimeForTest();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup();
});

function ownedAuthDir(accountId: string): string {
  hoisted.oauthDir = tempDirs.make("openclaw-wa-poll-retire-oauth-");
  const authDir = path.join(hoisted.oauthDir, "whatsapp", accountId);
  fsSync.mkdirSync(authDir, { recursive: true });
  fsSync.writeFileSync(path.join(authDir, "creds.json"), JSON.stringify({ me: SELF }), "utf-8");
  return authDir;
}

async function addVotedPoll(account: WhatsAppPollAccount, origin: "sent" | "received") {
  const pollMessageId = `${origin.toUpperCase()}1`;
  await recordWhatsAppPoll(
    {
      account,
      pollMessageId,
      origin,
      chatJids: [GROUP],
      creatorJids: [SELF.jid],
      question: "Pizza or sushi?",
      secret: new Uint8Array(32).fill(1),
      options: ["Pizza", "Sushi"],
      selectableCount: 1,
    },
    { mode: "overwrite" },
  );
  const record = (await env.openStore(WHATSAPP_POLL_RECORD_STORES[origin]).entries()).find((row) =>
    row.key.endsWith(`:${pollMessageId}`),
  )?.value as never;
  await applyWhatsAppPollVote({
    record,
    account,
    pollMessageId,
    voter: { jids: ["15550003333@s.whatsapp.net"], name: "Dana" },
    selected: ["Sushi"],
    votedAtMs: Date.now(),
  });
}

async function storedKeys(): Promise<string[]> {
  const keys: string[] = [];
  for (const options of ALL_STORES) {
    keys.push(...(await env.openStore(options).entries()).map((row) => row.key));
  }
  return keys.toSorted();
}

describe("logoutWeb poll state retirement", () => {
  it("removes every poll row of the logged-out account and keeps other accounts", async () => {
    for (const accountId of ["default", "work", "default:x"]) {
      await addVotedPoll({ accountId, self: SELF }, "sent");
      await addVotedPoll({ accountId, self: SELF }, "received");
    }
    expect(await storedKeys()).toHaveLength(18);

    const runtime = createRuntimeSpies();
    await expect(
      logoutWeb({ authDir: ownedAuthDir("default"), accountId: "default", runtime }),
    ).resolves.toBe(true);

    const keys = await storedKeys();
    expect(keys).toHaveLength(12);
    expect(keys.filter((key) => key.startsWith("default:"))).toEqual([]);
    expect(keys.filter((key) => key.startsWith("work:"))).toHaveLength(6);
    expect(keys.filter((key) => key.startsWith("default%3Ax:"))).toHaveLength(6);
  });

  it("still logs out without plugin state and says the rows expire", async () => {
    await addVotedPoll({ accountId: "default", self: SELF }, "sent");
    vi.spyOn(runtimeModule, "getOptionalWhatsAppRuntime").mockReturnValue(null);
    const runtime = createRuntimeSpies();
    await expect(
      logoutWeb({ authDir: ownedAuthDir("default"), accountId: "default", runtime }),
    ).resolves.toBe(true);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("WhatsApp poll state was not cleared here"),
    );
    vi.restoreAllMocks();
    expect(await storedKeys()).toHaveLength(3);
  });
});
