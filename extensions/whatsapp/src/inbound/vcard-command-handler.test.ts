import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateConfigMock } = vi.hoisted(() => ({ updateConfigMock: vi.fn() }));
vi.mock("openclaw/plugin-sdk/config-mutation", () => ({
  updateConfig: updateConfigMock,
}));

const sendMessageMock = vi.fn().mockResolvedValue(undefined);

import { handleVcardCommand } from "./vcard-command-handler.js";

const SELF_JID = "15550009999@s.whatsapp.net";
const OTHER_JID = "15550001111@s.whatsapp.net";
const SAMPLE_VCARD = "BEGIN:VCARD\nVERSION:3.0\nFN:John\nTEL:+5511999988888\nEND:VCARD";

function makeParams(
  overrides: Partial<{
    fromMe: boolean;
    selfChatMode: boolean;
    configWrites: boolean;
    command: string;
    quotedVcard: string | undefined;
    selfJid: string;
    remoteJid: string;
    accountId: string;
  }> = {},
) {
  return {
    fromMe: overrides.fromMe ?? true,
    selfChatMode: overrides.selfChatMode ?? true,
    configWrites: overrides.configWrites ?? true,
    command: overrides.command ?? "add",
    quotedVcard: "quotedVcard" in overrides ? overrides.quotedVcard : SAMPLE_VCARD,
    selfJid: overrides.selfJid ?? SELF_JID,
    remoteJid: overrides.remoteJid ?? SELF_JID,
    accountId: overrides.accountId ?? "default",
    sendMessage: sendMessageMock,
  };
}

function mockConfig(manualFrom: string[] = []) {
  updateConfigMock.mockImplementation(async (mutator: (cfg: unknown) => unknown) =>
    mutator({ channels: { whatsapp: { dmPolicy: "open-except", manualFrom } } }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig([]);
});

describe("handleVcardCommand", () => {
  it("returns null when selfChatMode is false", async () => {
    const result = await handleVcardCommand(makeParams({ selfChatMode: false }));
    expect(result).toBeNull();
    expect(updateConfigMock).not.toHaveBeenCalled();
  });

  it("returns null when configWrites is false", async () => {
    const result = await handleVcardCommand(makeParams({ configWrites: false }));
    expect(result).toBeNull();
    expect(updateConfigMock).not.toHaveBeenCalled();
  });

  it("returns null when not fromMe", async () => {
    const result = await handleVcardCommand(makeParams({ fromMe: false }));
    expect(result).toBeNull();
  });

  it("returns null when remoteJid is not selfJid", async () => {
    const result = await handleVcardCommand(makeParams({ remoteJid: OTHER_JID }));
    expect(result).toBeNull();
  });

  it("returns null when quotedVcard is absent", async () => {
    const result = await handleVcardCommand(makeParams({ quotedVcard: undefined }));
    expect(result).toBeNull();
  });

  it("returns null for unrecognized command", async () => {
    const result = await handleVcardCommand(makeParams({ command: "delete" }));
    expect(result).toBeNull();
  });

  it("returns null when vcard has no phone", async () => {
    const result = await handleVcardCommand({
      ...makeParams(),
      quotedVcard: "BEGIN:VCARD\nVERSION:3.0\nFN:John\nEND:VCARD",
    });
    expect(result).toBeNull();
  });

  it("add: adds phone and replies confirmation", async () => {
    mockConfig([]);
    const result = await handleVcardCommand(makeParams({ command: "add" }));
    expect(result).toBe("added");
    expect(updateConfigMock).toHaveBeenCalledOnce();
    expect(sendMessageMock).toHaveBeenCalledWith(SELF_JID, {
      text: "Added +5511999988888 to manual list",
    });
  });

  it("add: replies already-in-list when phone is present", async () => {
    mockConfig(["+5511999988888"]);
    const result = await handleVcardCommand(makeParams({ command: "add" }));
    expect(result).toBe("already");
    expect(updateConfigMock).toHaveBeenCalledTimes(1); // read-only pass
    expect(sendMessageMock).toHaveBeenCalledWith(SELF_JID, { text: "Already in manual list" });
  });

  it("rm: removes phone and replies confirmation", async () => {
    mockConfig(["+5511999988888"]);
    const result = await handleVcardCommand(makeParams({ command: "rm" }));
    expect(result).toBe("removed");
    expect(updateConfigMock).toHaveBeenCalledTimes(2); // read pass + write pass
    expect(sendMessageMock).toHaveBeenCalledWith(SELF_JID, {
      text: "Removed +5511999988888 from manual list",
    });
  });

  it("rm: replies not-in-list when phone is absent", async () => {
    mockConfig([]);
    const result = await handleVcardCommand(makeParams({ command: "rm" }));
    expect(result).toBe("not-found");
    expect(updateConfigMock).toHaveBeenCalledTimes(1); // read-only pass
    expect(sendMessageMock).toHaveBeenCalledWith(SELF_JID, { text: "Not in manual list" });
  });

  it("command matching is case-insensitive", async () => {
    const result = await handleVcardCommand(makeParams({ command: "ADD" }));
    expect(result).toBe("added");
  });

  it("command matching trims whitespace", async () => {
    const result = await handleVcardCommand(makeParams({ command: "  rm  " }));
    // no phone in list, so not-found
    expect(result).toBe("not-found");
  });
});
