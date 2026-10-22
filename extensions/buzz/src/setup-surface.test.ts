import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateSecretKey, nip19 } from "nostr-tools";
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  runSingleChannelSecretStep,
  type SecretInput,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { BuzzConfigInput } from "./config-schema.js";
import { waitForBuzzRoomAccess } from "./room-access-wait.js";
import { discoverBuzzRooms } from "./room-discovery.js";
import { buzzSetupWizard } from "./setup-surface.js";
import { verifyBuzzAfterSetup } from "./setup-verify.js";

vi.mock("nostr-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("nostr-tools")>()),
  generateSecretKey: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/setup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/setup")>()),
  runSingleChannelSecretStep: vi.fn(),
}));
vi.mock("./room-access-wait.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./room-access-wait.js")>()),
  waitForBuzzRoomAccess: vi.fn(),
}));
vi.mock("./room-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./room-discovery.js")>()),
  discoverBuzzRooms: vi.fn(),
}));
vi.mock("./setup-verify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./setup-verify.js")>()),
  verifyBuzzAfterSetup: vi.fn(),
}));

const discoverRooms = vi.mocked(discoverBuzzRooms);
const generate = vi.mocked(generateSecretKey);
const runSecretStep = vi.mocked(runSingleChannelSecretStep);
const waitForRoomAccess = vi.mocked(waitForBuzzRoomAccess);
const verifyAfterWrite = vi.mocked(verifyBuzzAfterSetup);

const ROOM_A = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const ROOM_B = "940d0c32-4eb7-46d7-9d5b-d975aaef87f7";
const GENERATED_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const AUTH_TAG = '["auth","bot","kind=9","signature"]';
const secretFixtureRoots: string[] = [];
const PRIVATE_KEY = nip19.nsecEncode(GENERATED_KEY);
const GENERAL_ROOM = { id: ROOM_A, name: "General" };
const AGENT_ROOM = { id: ROOM_B, name: "Agents" };

const config = (buzz: BuzzConfigInput): OpenClawConfig => ({ channels: { buzz } });

function poisonAmbientCredentials() {
  vi.stubEnv("BUZZ_PRIVATE_KEY", "33".repeat(32));
  vi.stubEnv("BUZZ_AUTH_TAG", "ambient-auth-must-not-be-used");
}

function createCredentialConfig(
  accountId: "default" | "ada",
  privateKey: SecretInput,
  authTag: SecretInput,
) {
  const healthyAccount = {
    enabled: true,
    name: "Healthy bot",
    relayUrl: "wss://healthy.example.com",
    privateKey: "11".repeat(32),
    authTag: '["auth","healthy","kind=9","signature"]',
    groups: { [ROOM_B]: { requireMention: true } },
    defaultTo: ROOM_B,
  };
  const selectedAccount = {
    enabled: true,
    name: "Selected bot",
    relayUrl: "wss://selected.example.com",
    privateKey,
    authTag,
    groupPolicy: "allowlist" as const,
    groupAllowFrom: [],
    groups: { [ROOM_A]: { requireMention: false, groupAllowFrom: [] } },
  };
  const cfg = config(
    accountId === "default"
      ? { ...selectedAccount, accounts: { ada: healthyAccount } }
      : { ...healthyAccount, accounts: { ada: selectedAccount } },
  );
  return { cfg, healthyAccount };
}

async function createStoredCredentials(source: "env" | "file") {
  if (source === "env") {
    vi.stubEnv("BUZZ_SETUP_PRIVATE_KEY", PRIVATE_KEY);
    vi.stubEnv("BUZZ_SETUP_AUTH_TAG", AUTH_TAG);
    return {
      privateKey: { source, provider: "default", id: "BUZZ_SETUP_PRIVATE_KEY" },
      authTag: { source, provider: "default", id: "BUZZ_SETUP_AUTH_TAG" },
    };
  }
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "buzz-setup-ref-")));
  secretFixtureRoots.push(root);
  const filePath = path.join(root, "credentials.json");
  await fs.writeFile(filePath, JSON.stringify({ privateKey: PRIVATE_KEY, authTag: AUTH_TAG }), {
    mode: 0o600,
  });
  return {
    privateKey: { source, provider: "buzzsetup", id: "/privateKey" },
    authTag: { source, provider: "buzzsetup", id: "/authTag" },
    secrets: { providers: { buzzsetup: { source, path: filePath, mode: "json" as const } } },
  };
}

function createPrompter(): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    plain: vi.fn(async () => {}),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    select: vi.fn(async ({ message }) => {
      if (message.includes("room access")) {
        return "retry";
      }
      if (message.includes("default")) {
        return ROOM_B;
      }
      throw new Error(`Unexpected select prompt: ${message}`);
    }) as WizardPrompter["select"],
    multiselect: vi.fn(async () => [ROOM_A, ROOM_B]) as WizardPrompter["multiselect"],
    text: vi.fn(async ({ message }) => {
      if (message.includes("relay")) {
        return "wss://buzz.example.com";
      }
      throw new Error(`Unexpected text prompt: ${message}`);
    }),
    confirm: vi.fn(async ({ message }) => {
      throw new Error(`Unexpected confirm prompt: ${message}`);
    }),
  };
}

type ConfigureParams = Parameters<typeof buzzSetupWizard.configure>[0];
let prompter: WizardPrompter;

function configure(params: Partial<ConfigureParams> = {}) {
  return buzzSetupWizard.configure({
    cfg: {},
    runtime: createRuntimeSpies(),
    prompter,
    accountOverrides: {},
    shouldPromptAccountIds: false,
    forceAllowFrom: false,
    ...params,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  prompter = createPrompter();
  generate.mockReturnValue(GENERATED_KEY);
  verifyAfterWrite.mockResolvedValue();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(secretFixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

it.each([false, true])(
  "generates a dedicated identity for a new named account: %s",
  async (named) => {
    const root = {
      name: "Root",
      relayUrl: "wss://root.example.com",
      privateKey: "11".repeat(32),
      groups: { [ROOM_A]: {} },
    };
    const roomIds = named ? [ROOM_B] : [ROOM_A, ROOM_B];
    const relayUrl = named ? "wss://ada.example.com" : "wss://buzz.example.com";
    const accountId = named ? "ada" : "default";
    discoverRooms.mockResolvedValue(
      named ? [AGENT_ROOM] : [{ ...GENERAL_ROOM, about: "Team room" }, AGENT_ROOM],
    );
    if (named) {
      vi.mocked(prompter.select).mockResolvedValueOnce("__new__");
      vi.mocked(prompter.text).mockResolvedValueOnce("ada").mockResolvedValueOnce(relayUrl);
    }
    const runtime = createRuntimeSpies();
    const hooks: Array<{
      run: (ctx: { cfg: OpenClawConfig; runtime: RuntimeEnv }) => void | Promise<void>;
    }> = [];
    const result = await configure({
      cfg: config(named ? root : { authTag: AUTH_TAG }),
      runtime,
      shouldPromptAccountIds: named,
      options: { onPostWriteHook: (hook) => hooks.push(hook) },
    });
    const expected = {
      enabled: true,
      relayUrl,
      privateKey: PRIVATE_KEY,
      groupPolicy: "open",
      groupAllowFrom: undefined,
      groups: Object.fromEntries(
        roomIds.map((id) => [id, { enabled: true, requireMention: false }]),
      ),
      defaultTo: ROOM_B,
    };
    expect(result.accountId).toBe(accountId);
    expect(result.cfg.channels?.buzz).toEqual(
      named ? { ...root, accounts: { ada: expected } } : expected,
    );
    expect(discoverRooms).toHaveBeenCalledWith({ relayUrl, privateKey: PRIVATE_KEY });
    expect(result.cfg.channels?.buzz?.authTag).toBeUndefined();
    expect(
      vi.mocked(prompter.note).mock.calls.some(([message]) => message.includes(PRIVATE_KEY)),
    ).toBe(false);
    expect(hooks).toHaveLength(1);
    await hooks[0]!.run({ cfg: result.cfg, runtime });
    expect(verifyAfterWrite).toHaveBeenCalledWith({ accountId, target: ROOM_B, runtime });
  },
);

it("keeps generated identities stable per account across wizard replay", async () => {
  poisonAmbientCredentials();
  const otherKey = Uint8Array.from({ length: 32 }, () => 7);
  generate.mockReturnValueOnce(GENERATED_KEY).mockReturnValueOnce(otherKey);
  discoverRooms.mockResolvedValue([AGENT_ROOM]);
  const cfg = config({
    enabled: false,
    relayUrl: "wss://root.example.com",
    privateKey: "11".repeat(32),
    authTag: AUTH_TAG,
    groups: { [ROOM_A]: {} },
  });
  const configureAccount = (accountId: string) =>
    configure({ cfg, accountOverrides: { buzz: accountId } });
  const ada = await configureAccount("ada");
  const grace = await configureAccount("grace");
  const replay = await configureAccount("ada");
  expect(generate).toHaveBeenCalledTimes(2);
  expect(ada.accountId).toBe("ada");
  expect(ada.cfg.channels?.buzz?.accounts?.ada?.privateKey).toBe(PRIVATE_KEY);
  expect(grace.cfg.channels?.buzz?.accounts?.grace?.privateKey).toBe(nip19.nsecEncode(otherKey));
  expect(replay.cfg).toEqual(ada.cfg);
  const { accounts: _accounts, ...root } = ada.cfg.channels!.buzz!;
  expect(root).toEqual(cfg.channels!.buzz);
  expect(ada.cfg.channels?.buzz?.accounts?.ada?.groups).toEqual({
    [ROOM_B]: { enabled: true, requireMention: false },
  });
  expect(discoverRooms).toHaveBeenCalledWith({
    relayUrl: "wss://buzz.example.com",
    privateKey: PRIVATE_KEY,
  });
});

it("uses the standard SecretRef route when entering a bot key", async () => {
  const secretRef = { source: "env" as const, provider: "default", id: "BUZZ_BOT_KEY" };
  runSecretStep.mockImplementation(
    async ({ cfg, applySet }: Parameters<typeof runSingleChannelSecretStep>[0]) => ({
      cfg: await applySet!(cfg, secretRef, PRIVATE_KEY),
      action: "set" as const,
      resolvedValue: PRIVATE_KEY,
    }),
  );
  discoverRooms.mockResolvedValue([GENERAL_ROOM]);
  vi.mocked(prompter.multiselect).mockResolvedValue([ROOM_A]);

  const result = await configure({ options: { secretInputMode: "ref" } });

  expect(runSecretStep).toHaveBeenCalledWith(
    expect.objectContaining({ secretInputMode: "ref", providerHint: "buzz" }),
  );
  expect(result.cfg.channels?.buzz?.privateKey).toEqual(secretRef);
});

it.each(["retry", "wait"] as const)(
  "keeps the identity stable through room-access %s",
  async (accessPath) => {
    discoverRooms.mockResolvedValueOnce([]);
    if (accessPath === "retry") {
      discoverRooms.mockResolvedValueOnce([GENERAL_ROOM]);
      waitForRoomAccess.mockResolvedValue([]);
    } else {
      waitForRoomAccess.mockResolvedValue([GENERAL_ROOM]);
    }
    const expectedKey = accessPath === "retry" ? "11".repeat(32) : PRIVATE_KEY;
    const cfg =
      accessPath === "retry"
        ? config({
            enabled: true,
            relayUrl: "wss://old.example.com",
            privateKey: expectedKey,
            groups: { [ROOM_A]: { enabled: true } },
            defaultTo: ROOM_A,
          })
        : {};
    const result = await configure({ cfg });
    expect(result.accountId).toBe("default");
    expect(result.completion).toBeUndefined();
    expect(result.cfg.channels?.buzz).toMatchObject({
      enabled: true,
      privateKey: expectedKey,
      defaultTo: ROOM_A,
    });
    const count = accessPath === "retry" ? 2 : 1;
    expect(discoverRooms.mock.calls.map(([args]) => args.privateKey)).toEqual(
      Array(count).fill(expectedKey),
    );
    expect(waitForRoomAccess).toHaveBeenCalledWith(
      expect.objectContaining({ privateKey: expectedKey }),
    );
    if (accessPath === "retry") {
      expect(prompter.note).toHaveBeenCalledWith(
        expect.stringContaining("Local `just dev` needs no separate community-member step"),
        "Buzz room access required",
      );
      expect(prompter.text).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("room UUID") }),
      );
      expect(prompter.select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Buzz room access is not ready",
          initialValue: "retry",
        }),
      );
    }
  },
);

it("keeps ada setup open after an empty room selection", async () => {
  const accountId = "ada";
  const { cfg } = createCredentialConfig(accountId, "22".repeat(32), AUTH_TAG);
  const before = structuredClone(cfg);
  discoverRooms.mockResolvedValue([GENERAL_ROOM, AGENT_ROOM]);
  vi.mocked(prompter.multiselect).mockResolvedValueOnce([]).mockResolvedValueOnce([ROOM_A]);
  const result = await configure({ cfg, accountOverrides: { buzz: accountId } });
  expect(result.accountId).toBe(accountId);
  expect(result.completion).toBeUndefined();
  expect(prompter.multiselect).toHaveBeenCalledTimes(2);
  expect(prompter.note).toHaveBeenCalledWith(
    expect.stringContaining("at least one"),
    "Buzz room selection required",
  );
  expect(discoverRooms).toHaveBeenCalledOnce();
  expect(result.cfg.channels?.buzz?.enabled).toBe(true);
  expect(result.cfg.channels?.buzz?.accounts?.ada?.enabled).toBe(true);
  expect(cfg).toEqual(before);
});

it("reports a configured identity as disabled", async () => {
  await expect(
    buzzSetupWizard.getStatus({
      cfg: config({
        enabled: false,
        relayUrl: "wss://buzz.example.com",
        privateKey: "11".repeat(32),
      }),
      accountOverrides: {},
    }),
  ).resolves.toEqual({
    channel: "buzz",
    configured: true,
    statusLines: ["Buzz: configured but disabled"],
    selectionHint: "configured but disabled",
  });
});

it("warns before using an unencrypted remote relay", async () => {
  discoverRooms.mockResolvedValue([GENERAL_ROOM]);
  vi.mocked(prompter.text).mockResolvedValueOnce("wss://buzz.example.com");
  vi.mocked(prompter.confirm).mockImplementation(async ({ message }) => {
    if (message.includes("unencrypted")) {
      return false;
    }
    throw new Error(`Unexpected confirm prompt: ${message}`);
  });

  const result = await configure({ cfg: config({ relayUrl: "ws://127.attacker.example" }) });

  expect(result.cfg.channels?.buzz?.relayUrl).toBe("wss://buzz.example.com");
  expect(prompter.confirm).toHaveBeenCalledWith({
    message: "This remote ws:// relay is unencrypted. Continue anyway?",
    initialValue: false,
  });
});

it.each([
  { accountId: "default", source: "env" },
  { accountId: "ada", source: "file" },
] as const)(
  "reuses $accountId $source refs without replacing authored credentials",
  async ({ accountId, source }) => {
    poisonAmbientCredentials();
    const stored = await createStoredCredentials(source);
    const configuredKey = stored.privateKey;
    const { cfg, healthyAccount } = createCredentialConfig(
      accountId,
      configuredKey,
      stored.authTag,
    );
    cfg.secrets = stored.secrets;
    const before = structuredClone(cfg);
    discoverRooms.mockResolvedValue([GENERAL_ROOM]);

    const result = await configure({ cfg, accountOverrides: { buzz: accountId } });

    expect(result.accountId).toBe(accountId);
    expect(result.completion).toBeUndefined();
    expect(discoverRooms).toHaveBeenCalledWith({
      relayUrl: "wss://selected.example.com",
      privateKey: PRIVATE_KEY,
      authTag: AUTH_TAG,
    });
    const { accounts, ...root } = result.cfg.channels!.buzz!;
    const selected = accountId === "default" ? root : accounts.ada;
    expect(accountId === "default" ? accounts.ada : root).toEqual(healthyAccount);
    expect(selected).toMatchObject({
      enabled: true,
      privateKey: configuredKey,
      authTag: stored.authTag,
      groupPolicy: "allowlist",
      groupAllowFrom: [],
      groups: { [ROOM_A]: { enabled: true, requireMention: false, groupAllowFrom: [] } },
      defaultTo: ROOM_A,
    });
    expect(cfg).toEqual(before);
    expect(generate).not.toHaveBeenCalled();
    expect(runSecretStep).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(prompter.note).mock.calls)).not.toContain(PRIVATE_KEY);
    expect(JSON.stringify(vi.mocked(prompter.note).mock.calls)).not.toContain(AUTH_TAG);
  },
);

it.each([
  { accountId: "default", field: "privateKey" },
  { accountId: "ada", field: "authTag" },
] as const)(
  "rejects unavailable $accountId $field refs without a configuration result or credential fallback",
  async ({ accountId, field }) => {
    poisonAmbientCredentials();
    vi.stubEnv("BUZZ_SETUP_MISSING", undefined);
    const secretRef = { source: "env", provider: "default", id: "BUZZ_SETUP_MISSING" } as const;
    const { cfg } = createCredentialConfig(
      accountId,
      field === "privateKey" ? secretRef : PRIVATE_KEY,
      field === "authTag" ? secretRef : AUTH_TAG,
    );
    const before = structuredClone(cfg);
    discoverRooms.mockResolvedValue([GENERAL_ROOM]);
    waitForRoomAccess.mockResolvedValue([]);

    const onPostWriteHook = vi.fn();

    await expect(
      configure({
        cfg,
        options: { onPostWriteHook },
        accountOverrides: { buzz: accountId },
      }),
    ).rejects.toThrow(/configured|SecretRef/i);
    expect(cfg).toEqual(before);
    expect(discoverRooms).not.toHaveBeenCalled();
    expect(waitForRoomAccess).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(runSecretStep).not.toHaveBeenCalled();
    expect(onPostWriteHook).not.toHaveBeenCalled();
  },
);
