import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { updateSessionStore } from "../../../src/config/sessions.js";
import { TelegramExecApprovalHandler } from "./exec-approvals-handler.js";

const baseRequest = {
  id: "9f1c7d5d-b1fb-46ef-ac45-662723b65bb7",
  request: {
    command: "npm view diver name version description",
    agentId: "main",
    sessionKey: "agent:main:telegram:group:-1003841603622:topic:928",
    turnSourceChannel: "telegram",
    turnSourceTo: "-1003841603622",
    turnSourceThreadId: "928",
    turnSourceAccountId: "default",
  },
  createdAtMs: 1000,
  expiresAtMs: 61_000,
};

const pluginRequest = {
  id: "plugin:9f1c7d5d-b1fb-46ef-ac45-662723b65bb7",
  request: {
    title: "Plugin Approval Required",
    description: "Allow plugin access",
    pluginId: "git-tools",
    agentId: "main",
    sessionKey: "agent:main:telegram:group:-1003841603622:topic:928",
    turnSourceChannel: "telegram",
    turnSourceTo: "-1003841603622",
    turnSourceThreadId: "928",
    turnSourceAccountId: "default",
  },
  createdAtMs: 1000,
  expiresAtMs: 61_000,
};

function createHandler(cfg: OpenClawConfig, accountId = "default") {
  const sendTyping = vi.fn().mockResolvedValue({ ok: true });
  const sendMessage = vi
    .fn()
    .mockResolvedValueOnce({ messageId: "m1", chatId: "-1003841603622" })
    .mockResolvedValue({ messageId: "m2", chatId: "8460800771" });
  const editReplyMarkup = vi.fn().mockResolvedValue({ ok: true });
  const handler = new TelegramExecApprovalHandler(
    {
      token: "tg-token",
      accountId,
      cfg,
    },
    {
      nowMs: () => 1000,
      sendTyping,
      sendMessage,
      editReplyMarkup,
    },
  );
  return { handler, sendTyping, sendMessage, editReplyMarkup };
}

describe("TelegramExecApprovalHandler", () => {
  it("sends approval prompts to the originating telegram topic when target=channel", async () => {
    const cfg = {
      channels: {
        telegram: {
          execApprovals: {
            enabled: true,
            approvers: ["8460800771"],
            target: "channel",
          },
        },
      },
    } as OpenClawConfig;
    const { handler, sendTyping, sendMessage } = createHandler(cfg);

    await handler.handleRequested(baseRequest);

    expect(sendTyping).toHaveBeenCalledWith(
      "-1003841603622",
      expect.objectContaining({
        accountId: "default",
        messageThreadId: 928,
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      "-1003841603622",
      expect.stringContaining("/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 allow-once"),
      expect.objectContaining({
        accountId: "default",
        messageThreadId: 928,
        buttons: [
          [
            {
              text: "Allow Once",
              callback_data: "/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 allow-once",
              style: "success",
            },
            {
              text: "Allow Always",
              callback_data: "/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 always",
              style: "primary",
            },
            {
              text: "Deny",
              callback_data: "/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 deny",
              style: "danger",
            },
          ],
        ],
      }),
    );
  });

  it("hides allow-always actions when ask=always", async () => {
    const cfg = {
      channels: {
        telegram: {
          execApprovals: {
            enabled: true,
            approvers: ["8460800771"],
            target: "channel",
          },
        },
      },
    } as OpenClawConfig;
    const { handler, sendMessage } = createHandler(cfg);

    await handler.handleRequested({
      ...baseRequest,
      request: {
        ...baseRequest.request,
        ask: "always",
      },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "-1003841603622",
      expect.not.stringContaining("allow-always"),
      expect.objectContaining({
        buttons: [
          [
            {
              text: "Allow Once",
              callback_data: "/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 allow-once",
              style: "success",
            },
            {
              text: "Deny",
              callback_data: "/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 deny",
              style: "danger",
            },
          ],
        ],
      }),
    );
  });

  it("falls back to approver DMs when channel routing is unavailable", async () => {
    const cfg = {
      channels: {
        telegram: {
          execApprovals: {
            enabled: true,
            approvers: ["111", "222"],
            target: "channel",
          },
        },
      },
    } as OpenClawConfig;
    const { handler, sendMessage } = createHandler(cfg);

    await handler.handleRequested({
      ...baseRequest,
      request: {
        ...baseRequest.request,
        turnSourceChannel: "slack",
        turnSourceTo: "U1",
        turnSourceAccountId: null,
        turnSourceThreadId: null,
      },
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.map((call) => call[0])).toEqual(["111", "222"]);
  });

  it("does not send foreign-channel approvals from unbound multi-account telegram configs", async () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            default: {
              execApprovals: {
                enabled: true,
                approvers: ["111"],
                target: "channel",
              },
            },
            secondary: {
              execApprovals: {
                enabled: true,
                approvers: ["222"],
                target: "channel",
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const defaultHandler = createHandler(cfg, "default");
    const secondaryHandler = createHandler(cfg, "secondary");
    const request = {
      ...baseRequest,
      request: {
        ...baseRequest.request,
        sessionKey: "agent:main:missing",
        turnSourceChannel: "slack",
        turnSourceTo: "U1",
        turnSourceAccountId: null,
        turnSourceThreadId: null,
      },
    };

    await defaultHandler.handler.handleRequested(request);
    await secondaryHandler.handler.handleRequested(request);

    expect(defaultHandler.sendMessage).not.toHaveBeenCalled();
    expect(secondaryHandler.sendMessage).not.toHaveBeenCalled();
  });

  it("does not double-send in direct chats when the origin chat is the approver DM", async () => {
    const cfg = {
      channels: {
        telegram: {
          execApprovals: {
            enabled: true,
            approvers: ["8460800771"],
            target: "dm",
          },
        },
      },
    } as OpenClawConfig;
    const { handler, sendMessage } = createHandler(cfg);

    await handler.handleRequested({
      ...baseRequest,
      request: {
        ...baseRequest.request,
        sessionKey: "agent:main:telegram:direct:8460800771",
        turnSourceTo: "telegram:8460800771",
        turnSourceThreadId: undefined,
      },
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "8460800771",
      expect.stringContaining("/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 allow-once"),
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("clears buttons from tracked approval messages when resolved", async () => {
    const cfg = {
      channels: {
        telegram: {
          execApprovals: {
            enabled: true,
            approvers: ["8460800771"],
            target: "both",
          },
        },
      },
    } as OpenClawConfig;
    const { handler, editReplyMarkup } = createHandler(cfg);

    await handler.handleRequested(baseRequest);
    await handler.handleResolved({
      id: baseRequest.id,
      decision: "allow-once",
      resolvedBy: "telegram:8460800771",
      ts: 2000,
    });

    expect(editReplyMarkup).toHaveBeenCalled();
    expect(editReplyMarkup).toHaveBeenCalledWith(
      "-1003841603622",
      "m1",
      [],
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("delivers plugin approvals through the shared native delivery planner", async () => {
    const cfg = {
      channels: {
        telegram: {
          execApprovals: {
            enabled: true,
            approvers: ["8460800771"],
            target: "dm",
          },
        },
      },
    } as OpenClawConfig;
    const { handler, sendMessage } = createHandler(cfg);

    await handler.handleRequested(pluginRequest);

    const [chatId, text, options] = sendMessage.mock.calls[0] ?? [];
    expect(chatId).toBe("8460800771");
    expect(text).toContain("Plugin approval required");
    expect(options).toEqual(
      expect.objectContaining({
        accountId: "default",
        buttons: expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({
              callback_data: "/approve plugin:9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 allow-once",
            }),
          ]),
        ]),
      }),
    );
  });

  it("delivers plugin approvals when the agent only exists in the Telegram session key", async () => {
    const cfg = {
      channels: {
        telegram: {
          execApprovals: {
            enabled: true,
            approvers: ["8460800771"],
            agentFilter: ["main"],
            target: "dm",
          },
        },
      },
    } as OpenClawConfig;
    const { handler, sendMessage } = createHandler(cfg);

    await handler.handleRequested({
      ...pluginRequest,
      request: {
        ...pluginRequest.request,
        agentId: undefined,
      },
    });

    const [chatId, text] = sendMessage.mock.calls[0] ?? [];
    expect(chatId).toBe("8460800771");
    expect(text).toContain("Plugin approval required");
  });

  it("does not deliver plugin approvals for a different Telegram account", async () => {
    const cfg = {
      channels: {
        telegram: {
          execApprovals: {
            enabled: true,
            approvers: ["8460800771"],
            target: "dm",
          },
          accounts: {
            secondary: {
              execApprovals: {
                enabled: true,
                approvers: ["999"],
                target: "dm",
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const { handler, sendMessage } = createHandler(cfg);

    await handler.handleRequested({
      ...pluginRequest,
      request: {
        ...pluginRequest.request,
        turnSourceAccountId: "secondary",
      },
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("falls back to the session-bound Telegram account when turn source account is missing", async () => {
    const sessionStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tg-approvals-"));
    const storePath = path.join(sessionStoreDir, "sessions.json");
    try {
      await updateSessionStore(storePath, (store) => {
        store[baseRequest.request.sessionKey] = {
          sessionId: "session-secondary",
          updatedAt: Date.now(),
          deliveryContext: {
            channel: "telegram",
            to: "-1003841603622",
            accountId: "secondary",
            threadId: 928,
          },
        };
      });

      const cfg = {
        session: { store: storePath },
        channels: {
          telegram: {
            execApprovals: {
              enabled: true,
              approvers: ["8460800771"],
              target: "channel",
            },
            accounts: {
              secondary: {
                execApprovals: {
                  enabled: true,
                  approvers: ["999"],
                  target: "channel",
                },
              },
            },
          },
        },
      } as OpenClawConfig;
      const defaultHandler = createHandler(cfg, "default");
      const secondaryHandler = createHandler(cfg, "secondary");
      const request = {
        ...baseRequest,
        request: {
          ...baseRequest.request,
          turnSourceAccountId: null,
        },
      };

      await defaultHandler.handler.handleRequested(request);
      await secondaryHandler.handler.handleRequested(request);

      expect(defaultHandler.sendMessage).not.toHaveBeenCalled();
      expect(secondaryHandler.sendMessage).toHaveBeenCalledWith(
        "-1003841603622",
        expect.stringContaining("/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 allow-once"),
        expect.objectContaining({
          accountId: "secondary",
          messageThreadId: 928,
        }),
      );
    } finally {
      await fs.rm(sessionStoreDir, { recursive: true, force: true });
    }
  });

  it("prefers the explicit Telegram turn-source account over stale session account state", async () => {
    const sessionStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tg-approvals-"));
    const storePath = path.join(sessionStoreDir, "sessions.json");
    try {
      await updateSessionStore(storePath, (store) => {
        store[baseRequest.request.sessionKey] = {
          sessionId: "session-secondary",
          updatedAt: Date.now(),
          deliveryContext: {
            channel: "telegram",
            to: "-1003841603622",
            accountId: "secondary",
            threadId: 928,
          },
        };
      });

      const cfg = {
        session: { store: storePath },
        channels: {
          telegram: {
            execApprovals: {
              enabled: true,
              approvers: ["8460800771"],
              target: "channel",
            },
            accounts: {
              secondary: {
                execApprovals: {
                  enabled: true,
                  approvers: ["999"],
                  target: "channel",
                },
              },
            },
          },
        },
      } as OpenClawConfig;
      const defaultHandler = createHandler(cfg, "default");
      const secondaryHandler = createHandler(cfg, "secondary");

      await defaultHandler.handler.handleRequested(baseRequest);
      await secondaryHandler.handler.handleRequested(baseRequest);

      expect(defaultHandler.sendMessage).toHaveBeenCalledWith(
        "-1003841603622",
        expect.stringContaining("/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 allow-once"),
        expect.objectContaining({
          accountId: "default",
          messageThreadId: 928,
        }),
      );
      expect(secondaryHandler.sendMessage).not.toHaveBeenCalled();
    } finally {
      await fs.rm(sessionStoreDir, { recursive: true, force: true });
    }
  });
});
