import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import * as setupRuntime from "openclaw/plugin-sdk/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginSetupWizardStatus } from "../../../test/helpers/plugins/setup-wizard.js";
import { imessagePlugin } from "./channel.js";
import * as channelRuntimeModule from "./channel.runtime.js";
import * as clientModule from "./client.js";
import {
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
} from "./group-policy.js";
import { probeIMessage } from "./probe.js";
import { imessageDmPolicy } from "./setup-core.js";
import { parseIMessageAllowFromEntries } from "./setup-surface.js";
import {
  formatIMessageChatTarget,
  inferIMessageTargetChatType,
  isAllowedIMessageSender,
  looksLikeIMessageExplicitTargetId,
  normalizeIMessageHandle,
  parseIMessageTarget,
} from "./targets.js";

const getIMessageSetupStatus = createPluginSetupWizardStatus(imessagePlugin);

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

describe("imessage targets", () => {
  it("parses chat_id targets", () => {
    const target = parseIMessageTarget("chat_id:123");
    expect(target).toEqual({ kind: "chat_id", chatId: 123 });
  });

  it("parses chat targets", () => {
    const target = parseIMessageTarget("chat:456");
    expect(target).toEqual({ kind: "chat_id", chatId: 456 });
  });

  it("parses sms handles with service", () => {
    const target = parseIMessageTarget("sms:+1555");
    expect(target).toEqual({ kind: "handle", to: "+1555", service: "sms" });
  });

  it("normalizes handles", () => {
    expect(normalizeIMessageHandle("Name@Example.com")).toBe("name@example.com");
    expect(normalizeIMessageHandle(" +1 (555) 222-3333 ")).toBe("+15552223333");
  });

  it("normalizes chat_id prefixes case-insensitively", () => {
    expect(normalizeIMessageHandle("CHAT_ID:123")).toBe("chat_id:123");
    expect(normalizeIMessageHandle("Chat_Id:456")).toBe("chat_id:456");
    expect(normalizeIMessageHandle("chatid:789")).toBe("chat_id:789");
    expect(normalizeIMessageHandle("CHAT:42")).toBe("chat_id:42");
  });

  it("normalizes chat_guid prefixes case-insensitively", () => {
    expect(normalizeIMessageHandle("CHAT_GUID:abc-def")).toBe("chat_guid:abc-def");
    expect(normalizeIMessageHandle("ChatGuid:XYZ")).toBe("chat_guid:XYZ");
    expect(normalizeIMessageHandle("GUID:test-guid")).toBe("chat_guid:test-guid");
  });

  it("normalizes chat_identifier prefixes case-insensitively", () => {
    expect(normalizeIMessageHandle("CHAT_IDENTIFIER:iMessage;-;chat123")).toBe(
      "chat_identifier:iMessage;-;chat123",
    );
    expect(normalizeIMessageHandle("ChatIdentifier:test")).toBe("chat_identifier:test");
    expect(normalizeIMessageHandle("CHATIDENT:foo")).toBe("chat_identifier:foo");
  });

  it("checks allowFrom against chat_id", () => {
    const ok = isAllowedIMessageSender({
      allowFrom: ["chat_id:9"],
      sender: "+1555",
      chatId: 9,
    });
    expect(ok).toBe(true);
  });

  it("checks allowFrom against handle", () => {
    const ok = isAllowedIMessageSender({
      allowFrom: ["user@example.com"],
      sender: "User@Example.com",
    });
    expect(ok).toBe(true);
  });

  it("denies when allowFrom is empty", () => {
    const ok = isAllowedIMessageSender({
      allowFrom: [],
      sender: "+1555",
    });
    expect(ok).toBe(false);
  });

  it("formats chat targets", () => {
    expect(formatIMessageChatTarget(42)).toBe("chat_id:42");
    expect(formatIMessageChatTarget(undefined)).toBe("");
  });

  it("only treats explicit chat targets as immediate ids", () => {
    expect(looksLikeIMessageExplicitTargetId("chat_id:42")).toBe(true);
    expect(looksLikeIMessageExplicitTargetId("sms:+15552223333")).toBe(true);
    expect(looksLikeIMessageExplicitTargetId("+15552223333")).toBe(false);
    expect(looksLikeIMessageExplicitTargetId("user@example.com")).toBe(false);
  });

  it("infers direct and group chat types from normalized targets", () => {
    expect(inferIMessageTargetChatType("+15552223333")).toBe("direct");
    expect(inferIMessageTargetChatType("chat_id:42")).toBe("group");
  });
});

describe("createIMessageRpcClient", () => {
  beforeEach(() => {
    spawnMock.mockClear();
    vi.stubEnv("VITEST", "true");
  });

  it("refuses to spawn imsg rpc in test environments", async () => {
    const { createIMessageRpcClient } = await import("./client.js");
    await expect(createIMessageRpcClient()).rejects.toThrow(
      /Refusing to start imsg rpc in test environment/i,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("imessage group policy", () => {
  it("uses generic channel group policy helpers", () => {
    const cfg = {
      channels: {
        imessage: {
          groups: {
            "chat:family": {
              requireMention: false,
              tools: { deny: ["exec"] },
            },
            "*": {
              requireMention: true,
              tools: { allow: ["message.send"] },
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    expect(resolveIMessageGroupRequireMention({ cfg, groupId: "chat:family" })).toBe(false);
    expect(resolveIMessageGroupRequireMention({ cfg, groupId: "chat:other" })).toBe(true);
    expect(resolveIMessageGroupToolPolicy({ cfg, groupId: "chat:family" })).toEqual({
      deny: ["exec"],
    });
    expect(resolveIMessageGroupToolPolicy({ cfg, groupId: "chat:other" })).toEqual({
      allow: ["message.send"],
    });
  });
});

describe("parseIMessageAllowFromEntries", () => {
  it("parses handles and chat targets", () => {
    expect(parseIMessageAllowFromEntries("+15555550123, chat_id:123, chat_guid:abc")).toEqual({
      entries: ["+15555550123", "chat_id:123", "chat_guid:abc"],
    });
  });

  it("returns validation errors for invalid chat_id", () => {
    expect(parseIMessageAllowFromEntries("chat_id:abc")).toEqual({
      entries: [],
      error: "Invalid chat_id: chat_id:abc",
    });
  });

  it("returns validation errors for invalid chat_identifier entries", () => {
    expect(parseIMessageAllowFromEntries("chat_identifier:")).toEqual({
      entries: [],
      error: "Invalid chat_identifier entry",
    });
  });

  it("reads the named-account DM policy instead of the channel root", () => {
    expect(
      imessageDmPolicy.getCurrent(
        {
          channels: {
            imessage: {
              dmPolicy: "disabled",
              accounts: {
                work: {
                  cliPath: "imsg",
                  dmPolicy: "allowlist",
                },
              },
            },
          },
        },
        "work",
      ),
    ).toBe("allowlist");
  });

  it("reports account-scoped config keys for named accounts", () => {
    expect(imessageDmPolicy.resolveConfigKeys?.({ channels: { imessage: {} } }, "work")).toEqual({
      policyKey: "channels.imessage.accounts.work.dmPolicy",
      allowFromKey: "channels.imessage.accounts.work.allowFrom",
    });
  });

  it('writes open policy state to the named account and preserves inherited allowFrom with "*"', () => {
    const next = imessageDmPolicy.setPolicy(
      {
        channels: {
          imessage: {
            allowFrom: ["+15555550123"],
            accounts: {
              work: {
                cliPath: "imsg",
              },
            },
          },
        },
      },
      "open",
      "work",
    );

    expect(next.channels?.imessage?.dmPolicy).toBeUndefined();
    expect(next.channels?.imessage?.allowFrom).toEqual(["+15555550123"]);
    expect(next.channels?.imessage?.accounts?.work?.dmPolicy).toBe("open");
    expect(next.channels?.imessage?.accounts?.work?.allowFrom).toEqual(["+15555550123", "*"]);
  });

  it("uses the configured default account for omitted-account DM policy reads, keys, and writes", () => {
    const cfg = {
      channels: {
        imessage: {
          allowFrom: ["+15555550123"],
          defaultAccount: "work",
          accounts: {
            work: {
              cliPath: "imsg",
              dmPolicy: "allowlist" as const,
              allowFrom: ["chat_id:123"],
            },
          },
        },
      },
    };

    expect(imessageDmPolicy.getCurrent(cfg)).toBe("allowlist");
    expect(imessageDmPolicy.resolveConfigKeys?.(cfg)).toEqual({
      policyKey: "channels.imessage.accounts.work.dmPolicy",
      allowFromKey: "channels.imessage.accounts.work.allowFrom",
    });

    const next = imessageDmPolicy.setPolicy(cfg, "open");

    expect(next.channels?.imessage?.dmPolicy).toBeUndefined();
    expect(next.channels?.imessage?.allowFrom).toEqual(["+15555550123"]);
    expect(next.channels?.imessage?.accounts?.work?.dmPolicy).toBe("open");
    expect(next.channels?.imessage?.accounts?.work?.allowFrom).toEqual(["chat_id:123", "*"]);
  });
});

describe("imessage setup status", () => {
  it("does not inherit configured state from a sibling account", async () => {
    const result = await getIMessageSetupStatus({
      cfg: {
        channels: {
          imessage: {
            accounts: {
              default: {
                cliPath: "/usr/local/bin/imsg",
              },
              work: {},
            },
          },
        },
      },
      accountOverrides: {
        imessage: "work",
      },
    });

    expect(result.configured).toBe(false);
    expect(result.statusLines).toContain("iMessage: needs setup");
  });
});

describe("probeIMessage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(setupRuntime, "detectBinary").mockResolvedValue(true);
    vi.spyOn(processRuntime, "runCommandWithTimeout").mockResolvedValue({
      stdout: "",
      stderr: 'unknown command "rpc" for "imsg"',
      code: 1,
      signal: null,
      killed: false,
      termination: "exit",
    });
  });

  it("marks unknown rpc subcommand as fatal", async () => {
    const createIMessageRpcClientMock = vi
      .spyOn(clientModule, "createIMessageRpcClient")
      .mockResolvedValue({
        request: vi.fn(),
        stop: vi.fn(),
      } as unknown as Awaited<ReturnType<typeof clientModule.createIMessageRpcClient>>);
    const result = await probeIMessage(1000, { cliPath: "imsg-test-rpc" });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.error).toMatch(/rpc/i);
    expect(createIMessageRpcClientMock).not.toHaveBeenCalled();
  });

  it("status probe uses account-scoped cliPath and dbPath", async () => {
    const probeAccount = imessagePlugin.status?.probeAccount;
    if (!probeAccount) {
      throw new Error("imessage status.probeAccount unavailable");
    }

    const probeSpy = vi.spyOn(channelRuntimeModule, "probeIMessageAccount").mockResolvedValue({
      ok: true,
      cliPath: "imsg-work",
      dbPath: "/tmp/work-db",
    } as Awaited<ReturnType<typeof channelRuntimeModule.probeIMessageAccount>>);

    const cfg = {
      channels: {
        imessage: {
          cliPath: "imsg-root",
          dbPath: "/tmp/root-db",
          accounts: {
            work: {
              cliPath: "imsg-work",
              dbPath: "/tmp/work-db",
            },
          },
        },
      },
    } as const;
    const account = imessagePlugin.config.resolveAccount(cfg, "work");

    await probeAccount({ account, cfg, timeoutMs: 2500 } as never);

    expect(probeSpy).toHaveBeenCalledWith({
      timeoutMs: 2500,
      cliPath: "imsg-work",
      dbPath: "/tmp/work-db",
    });
  });

  it("setup status lines use the selected account cliPath", async () => {
    const status = await getIMessageSetupStatus({
      cfg: {
        channels: {
          imessage: {
            cliPath: "/tmp/root-imsg",
            accounts: {
              work: {
                cliPath: "/tmp/work-imsg",
              },
            },
          },
        },
      } as never,
      accountOverrides: { imessage: "work" },
    });

    expect(status.statusLines).toContain("imsg: missing (/tmp/work-imsg)");
  });
});
