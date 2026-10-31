import fs from "node:fs/promises";
import path from "node:path";
import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage } from "baileys";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappPlugin } from "./channel.js";
import { createAttachedTestListener } from "./inbound/attached-listener.test-support.js";
import type { ActiveWebListener } from "./inbound/types.js";
import { cacheInboundMessageMeta } from "./quoted-message.js";

const hoisted = vi.hoisted(() => ({
  controllerListeners: new Map<string, ActiveWebListener>(),
}));

vi.mock("./connection-controller-runtime-context.js", async () => {
  const actual = await vi.importActual<typeof import("./connection-controller-runtime-context.js")>(
    "./connection-controller-runtime-context.js",
  );
  return {
    ...actual,
    getWhatsAppConnectionController: vi.fn((accountId: string) => {
      const listener = hoisted.controllerListeners.get(accountId);
      return listener ? { getActiveListener: () => listener } : null;
    }),
  };
});

const { agentPrompt, actions } = whatsappPlugin;

function config(whatsapp: NonNullable<OpenClawConfig["channels"]>["whatsapp"]): OpenClawConfig {
  return { channels: { whatsapp: { allowFrom: ["*"], ...whatsapp } } };
}

describe("whatsapp public channel actions", () => {
  it.each([
    ["default", config({}), "minimal"],
    ["unconfigured", {}, undefined],
    ["disabled actions", config({ actions: { reactions: false } }), undefined],
    ["ack only", config({ reactionLevel: "ack" }), undefined],
  ] as const)("reaction guidance: %s", (_name, cfg, level) => {
    const guidance = agentPrompt?.reactionGuidance?.({ cfg, accountId: "default" });
    if (level === undefined) {
      expect(guidance).toBeUndefined();
    } else {
      expect(guidance?.level).toBe(level);
    }
  });

  const withReactions = ["react", "poll", "edit", "upload-file"];
  const withoutReactions = ["poll", "edit", "upload-file"];
  const namedAccount = config({
    reactionLevel: "ack",
    accounts: { work: { reactionLevel: "minimal" } },
  });
  it.each([
    ["default", config({}), "default", withReactions],
    ["unconfigured", {}, "default", null],
    ["edit gate on", config({ actions: { editMessage: true } }), "default", withReactions],
    [
      "edit gate off",
      config({ actions: { editMessage: false } }),
      "default",
      ["react", "poll", "upload-file"],
    ],
    ["ack only", config({ reactionLevel: "ack" }), "default", withoutReactions],
    ["active account", namedAccount, "work", withReactions],
    ["any enabled account", namedAccount, undefined, withReactions],
    [
      "disabled account",
      config({
        reactionLevel: "ack",
        accounts: { work: { enabled: false, reactionLevel: "minimal" } },
      }),
      undefined,
      withoutReactions,
    ],
  ] as const)("action discovery: %s", (_name, cfg, accountId, expected) => {
    const result = actions?.describeMessageTool({ cfg, accountId });
    if (expected === null) {
      expect(result).toBeNull();
    } else {
      expect(result?.actions).toEqual(expected);
    }
  });

  it("leaves other actions unsupported and local", () => {
    expect(actions?.supportsAction?.({ action: "delete" })).toBe(false);
    expect(actions?.resolveExecutionMode?.({ action: "delete" })).toBe("local");
  });
});

describe("whatsapp edit through the action handler", () => {
  const target = "+15555550100";
  const targetJid = "15555550100@s.whatsapp.net";
  const otherTarget = "+15555550101";
  const updatedText = "updated";
  const rawSend =
    vi.fn<
      (
        jid: string,
        content: AnyMessageContent,
        options?: MiscMessageGenerationOptions,
      ) => Promise<WAMessage | undefined>
    >();
  const fetchReachoutTimelock = vi.fn(async () => ({ isActive: false }));
  let authDir: string;

  beforeAll(async () => {
    authDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-wa-edit-"));
  });

  afterAll(async () => {
    await fs.rm(authDir, { recursive: true, force: true });
  });

  async function installListener(accountId: string) {
    const listener = await createAttachedTestListener({
      accountId,
      authDir,
      sendMessage: rawSend,
      fetchAccountReachoutTimelock: fetchReachoutTimelock,
    });
    hoisted.controllerListeners.set(accountId, listener);
  }

  function dispatchEdit(cfg: OpenClawConfig, messageId: string, accountId = "default") {
    return actions?.handleAction?.({
      channel: "whatsapp",
      action: "edit",
      cfg,
      accountId,
      params: { to: target, messageId, message: updatedText },
    });
  }

  function expectEditOnSocket(messageId: string) {
    expect(rawSend).toHaveBeenCalledOnce();
    expect(rawSend.mock.calls[0]?.slice(0, 2)).toEqual([
      targetJid,
      { text: updatedText, edit: { remoteJid: targetJid, id: messageId, fromMe: true } },
    ]);
  }

  beforeEach(async () => {
    rawSend.mockReset();
    fetchReachoutTimelock.mockClear();
    rawSend.mockResolvedValue({ key: { id: "edit-receipt" } } as WAMessage);
    hoisted.controllerListeners.clear();
    await installListener("default");
  });

  it("submits an allowed edit to the socket without claiming confirmation", async () => {
    cacheInboundMessageMeta("default", targetJid, "sent-own", { fromMe: true });
    const result = await dispatchEdit(config({ allowFrom: [target] }), "sent-own");
    expect(result?.details).toEqual({
      ok: true,
      submitted: true,
      confirmed: false,
      messageId: "sent-own",
    });
    expectEditOnSocket("sent-own");
  });

  it("rejects a target outside allowFrom before the socket", async () => {
    await expect(
      dispatchEdit(config({ allowFrom: [otherTarget] }), "sent-own"),
    ).rejects.toMatchObject({ name: "ToolAuthorizationError" });
    expect(rawSend).not.toHaveBeenCalled();
  });

  it("applies the selected account's allowFrom even when another account allows the target", async () => {
    await installListener("work");
    const cfg = config({
      allowFrom: undefined,
      accounts: { work: { allowFrom: [otherTarget] }, home: { allowFrom: [target] } },
    });
    await expect(dispatchEdit(cfg, "sent-own", "work")).rejects.toMatchObject({
      name: "ToolAuthorizationError",
    });
    expect(rawSend).not.toHaveBeenCalled();
  });

  it("rejects a message cached as sent by someone else", async () => {
    cacheInboundMessageMeta("default", targetJid, "sent-foreign", { fromMe: false });
    await expect(dispatchEdit(config({ allowFrom: [target] }), "sent-foreign")).rejects.toThrow(
      "WhatsApp edit rejected: message was not sent by this account.",
    );
    expect(rawSend).not.toHaveBeenCalled();
  });

  it("proceeds on a cache miss as fromMe:true, leaving a foreign key for WhatsApp to refuse", async () => {
    const result = await dispatchEdit(config({ allowFrom: [target] }), "sent-uncached");
    expect(result?.details).toMatchObject({ submitted: true, confirmed: false });
    expectEditOnSocket("sent-uncached");
  });

  it("rejects when actions.editMessage is off", async () => {
    const cfg = config({ allowFrom: [target], actions: { editMessage: false } });
    await expect(dispatchEdit(cfg, "sent-own")).rejects.toThrow(
      "WhatsApp message editing is disabled.",
    );
    expect(rawSend).not.toHaveBeenCalled();
  });
});
