/**
 * Regression tests for QQBot command authorization alignment with the shared
 * command-auth model.
 *
 * Covers the regression identified in the code review:
 *
 *   allowFrom entries with the qqbot: prefix must normalize correctly so that
 *   "qqbot:<id>" in channel.allowFrom matches the inbound event.senderId "<id>".
 *   Verified against the normalization logic in the gateway.ts inbound path.
 *
 * Note: commands.allowFrom.qqbot precedence over channel allowFrom is enforced
 * by the framework's resolveCommandAuthorization(). QQBot routes requireAuth:true
 * commands through the framework (api.registerCommand), so that behavior is
 * covered by the framework's own tests rather than duplicated here.
 */

import { describe, expect, it } from "vitest";
import { qqbotPlugin } from "./channel.js";
import { registerQQBotFrameworkCommands } from "./bridge/commands/framework-registration.js";
import {
  getFrameworkCommands,
  matchSlashCommand,
  registerApproveRuntimeGetter,
} from "./engine/commands/slash-commands-impl.js";

// ---------------------------------------------------------------------------
// qqbot: prefix normalization for inbound commandAuthorized
//
// Uses qqbotPlugin.config.formatAllowFrom directly — the same function the
// fixed gateway.ts inbound path calls — so the test stays in sync with the
// actual implementation without duplicating the logic.
// ---------------------------------------------------------------------------

describe("qqbot: prefix normalization for inbound commandAuthorized", () => {
  const formatAllowFrom = qqbotPlugin.config.formatAllowFrom!;

  /** Mirrors the fixed gateway.ts inbound commandAuthorized computation. */
  function resolveInboundCommandAuthorized(rawAllowFrom: string[], senderId: string): boolean {
    const normalizedAllowFrom = formatAllowFrom({
      cfg: {} as never,
      accountId: null,
      allowFrom: rawAllowFrom,
    });
    const normalizedSenderId = senderId.replace(/^qqbot:/i, "").toUpperCase();
    const allowAll = normalizedAllowFrom.length === 0 || normalizedAllowFrom.some((e) => e === "*");
    return allowAll || normalizedAllowFrom.includes(normalizedSenderId);
  }

  it("authorizes when allowFrom uses qqbot: prefix and senderId is the bare id", () => {
    expect(resolveInboundCommandAuthorized(["qqbot:USER123"], "USER123")).toBe(true);
  });

  it("authorizes when qqbot: prefix is mixed case", () => {
    expect(resolveInboundCommandAuthorized(["QQBot:user123"], "USER123")).toBe(true);
  });

  it("denies a sender not in the qqbot:-prefixed allowFrom list", () => {
    expect(resolveInboundCommandAuthorized(["qqbot:USER123"], "OTHER")).toBe(false);
  });

  it("authorizes any sender when allowFrom is empty (open)", () => {
    expect(resolveInboundCommandAuthorized([], "ANYONE")).toBe(true);
  });

  it("authorizes any sender when allowFrom contains wildcard *", () => {
    expect(resolveInboundCommandAuthorized(["*"], "ANYONE")).toBe(true);
  });
});

describe("qqbot sensitive slash commands", () => {
  type CapturedFrameworkCommand = {
    name: string;
    handler: (ctx: {
      args?: string;
      from?: string;
      config: Record<string, unknown>;
      accountId?: string;
      senderId?: string;
      messageId?: string;
      channel?: string;
    }) => Promise<{ text: string }>;
  };

  it("/bot-approve is framework-registered and does not execute in pre-dispatch", async () => {
    const frameworkCommands = getFrameworkCommands().map((cmd) => cmd.name);
    expect(frameworkCommands).toContain("bot-approve");

    const configState: Record<string, unknown> = {};
    registerApproveRuntimeGetter(() => ({
      config: {
        loadConfig: () => configState,
        writeConfigFile: async (cfg) => {
          for (const key of Object.keys(configState)) {
            delete configState[key];
          }
          Object.assign(configState, cfg as Record<string, unknown>);
        },
      },
    }));

    const result = await matchSlashCommand({
      type: "c2c",
      senderId: "USER123",
      messageId: "msg-1",
      eventTimestamp: new Date(0).toISOString(),
      receivedAt: 0,
      rawContent: "/bot-approve off",
      args: "",
      accountId: "account-1",
      appId: "app-1",
      commandAuthorized: false,
      queueSnapshot: {
        totalPending: 0,
        activeUsers: 0,
        maxConcurrentUsers: 0,
        senderPending: 0,
      },
    });

    expect(result).toBeNull();
    expect(configState).toEqual({});
  });

  it("/bot-approve keeps usage help on the framework-auth path", async () => {
    let registeredFrameworkCommand: CapturedFrameworkCommand | undefined;

    registerApproveRuntimeGetter(() => ({
      config: {
        loadConfig: () => ({}),
        writeConfigFile: async () => {},
      },
    }));

    registerQQBotFrameworkCommands({
      registerCommand(command: CapturedFrameworkCommand) {
        if (command.name === "bot-approve") {
          registeredFrameworkCommand = command;
        }
      },
    } as never);

    expect(registeredFrameworkCommand).toBeTruthy();

    const result = await registeredFrameworkCommand?.handler({
      args: "?",
      from: "qqbot:c2c:USER123",
      config: {
        channels: {
          qqbot: {
            appId: "123456",
          },
        },
      },
      accountId: "default",
      senderId: "USER123",
      messageId: "msg-1",
      channel: "qqbot",
    });

    expect(result?.text).toContain("/bot-approve on");
    expect(result?.text).toContain("/bot-approve status");
  });

  it("/bot-approve rejects non-QQ framework channels", async () => {
    let registeredFrameworkCommand: CapturedFrameworkCommand | undefined;
    const configState: Record<string, unknown> = {};

    registerApproveRuntimeGetter(() => ({
      config: {
        loadConfig: () => configState,
        writeConfigFile: async (cfg) => {
          for (const key of Object.keys(configState)) {
            delete configState[key];
          }
          Object.assign(configState, cfg as Record<string, unknown>);
        },
      },
    }));

    registerQQBotFrameworkCommands({
      registerCommand(command: CapturedFrameworkCommand) {
        if (command.name === "bot-approve") {
          registeredFrameworkCommand = command;
        }
      },
    } as never);

    expect(registeredFrameworkCommand).toBeTruthy();

    const result = await registeredFrameworkCommand?.handler({
      args: "off",
      from: "telegram:group:-100123",
      config: {},
      accountId: "default",
      senderId: "USER123",
      messageId: "msg-1",
      channel: "telegram",
    });

    expect(result?.text).toContain("only available on QQBot");
    expect(configState).toEqual({});
  });
});
