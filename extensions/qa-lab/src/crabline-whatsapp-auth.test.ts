import fs from "node:fs/promises";
import path from "node:path";
import { startOpenClawCrablineAdapter } from "@openclaw/crabline";
import {
  createWhatsAppQaAuthState,
  resolveWhatsAppAccount,
  resolveWhatsAppAuthDir,
} from "@openclaw/whatsapp/api.js";
import { WhatsAppConfigSchema } from "@openclaw/whatsapp/config-api.js";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCrablineDiscordReplies } from "./crabline-discord-replies.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";
import { readQaScenarioExecutionConfig } from "./scenario-catalog.js";

vi.mock("@openclaw/crabline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/crabline")>();
  return { ...actual, startOpenClawCrablineAdapter: vi.fn(actual.startOpenClawCrablineAdapter) };
});
vi.mock("@openclaw/whatsapp/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/whatsapp/api.js")>();
  return { ...actual, createWhatsAppQaAuthState: vi.fn(actual.createWhatsAppQaAuthState) };
});
vi.mock("./crabline-discord-replies.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./crabline-discord-replies.js")>();
  return { ...actual, startCrablineDiscordReplies: vi.fn(actual.startCrablineDiscordReplies) };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const selection = {
  capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
  channel: "whatsapp",
  channelDriver: "crabline",
  providerReadinessArtifactPath: "crabline-provider-readiness.json",
} as const;

describe("Crabline WhatsApp fixture authentication", () => {
  it("links the isolated account before Gateway startup and retains it until Gateway teardown", async () => {
    await withTempDir("qa-crabline-whatsapp-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({ outputDir, selection });
      let authDir: string | undefined;
      try {
        const authResult = vi.mocked(createWhatsAppQaAuthState).mock.results[0];
        if (!authResult || authResult.type !== "return") {
          throw new Error("WhatsApp fixture did not initialize auth state");
        }
        authDir = await authResult.value;
        const config = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" });
        const whatsapp = WhatsAppConfigSchema.parse(config.channels?.whatsapp);
        expect(whatsapp.accounts?.[transport.accountId]?.authDir).toBe(authDir);
        expect(resolveWhatsAppAuthDir({ cfg: config, accountId: transport.accountId })).toEqual({
          authDir,
          isLegacy: false,
        });
        expect(
          resolveWhatsAppAccount({ cfg: config, accountId: transport.accountId }).authDir,
        ).toBe(authDir);
        expect(authDir).toEqual(expect.any(String));
        if (!authDir) {
          throw new Error("WhatsApp fixture auth directory is missing");
        }
        const credsPath = path.join(authDir, "creds.json");
        const before = await fs.readFile(credsPath, "utf8");
        expect(JSON.parse(before)).toMatchObject({
          me: { id: "15550000000@s.whatsapp.net" },
          registered: false,
        });
        await transport.reset();
        await transport.cleanup?.();
        expect(
          transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:2" }).channels?.whatsapp
            ?.accounts?.[transport.accountId]?.authDir,
        ).toBe(authDir);
        expect(await fs.readFile(credsPath, "utf8")).toBe(before);
      } finally {
        await transport.cleanupAfterGatewayStop?.();
      }
      if (authDir) {
        await expect(fs.lstat(authDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
  });

  it("admits the actual restart scenario's direct peer through the Crabline provider contract", async () => {
    await withTempDir("qa-crabline-whatsapp-peer-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({ outputDir, selection });
      try {
        const config = readQaScenarioExecutionConfig("whatsapp-restart-resume");
        if (typeof config?.conversationId !== "string" || typeof config.senderId !== "string") {
          throw new Error("WhatsApp restart scenario is missing its direct peer");
        }
        expect(config.conversationId).not.toBe("15550000000@s.whatsapp.net");
        await expect(
          transport.sendInbound({
            conversation: { id: config.conversationId, kind: "direct" },
            senderId: config.senderId,
            text: "synthetic restart peer",
          }),
        ).resolves.toMatchObject({ text: "synthetic restart peer" });
      } finally {
        await transport.cleanupAfterGatewayStop?.();
      }
    });
  });

  it("rolls back seeded auth and closes the provider when later factory initialization fails", async () => {
    await withTempDir("qa-crabline-whatsapp-rollback-", async (outputDir) => {
      vi.mocked(startCrablineDiscordReplies).mockRejectedValueOnce(
        new Error("state initialization failed"),
      );
      await expect(createQaCrablineTransportAdapter({ outputDir, selection })).rejects.toThrow(
        "state initialization failed",
      );
      const authResult = vi.mocked(createWhatsAppQaAuthState).mock.results[0];
      const adapterResult = vi.mocked(startOpenClawCrablineAdapter).mock.results[0];
      if (!authResult || authResult.type !== "return") {
        throw new Error("WhatsApp fixture did not initialize auth state");
      }
      if (!adapterResult || adapterResult.type !== "return") {
        throw new Error("WhatsApp fixture did not start its provider");
      }
      const authDir = await authResult.value;
      const adapter = await adapterResult.value;
      await expect(fs.lstat(authDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(adapter.probe()).rejects.toThrow();
    });
  });

  it("attempts both provider and auth cleanup and reports both failures after Gateway stop", async () => {
    await withTempDir("qa-crabline-whatsapp-cleanup-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({ outputDir, selection });
      const adapterResult = vi.mocked(startOpenClawCrablineAdapter).mock.results[0];
      const authResult = vi.mocked(createWhatsAppQaAuthState).mock.results[0];
      if (!adapterResult || adapterResult.type !== "return") {
        throw new Error("WhatsApp fixture did not start its provider");
      }
      if (!authResult || authResult.type !== "return") {
        throw new Error("WhatsApp fixture did not initialize auth state");
      }
      const adapter = await adapterResult.value;
      const authDir = await authResult.value;
      const close = adapter.close.bind(adapter);
      const providerFailure = new Error("provider close failed");
      const authFailure = new Error("auth removal failed");
      vi.spyOn(adapter, "close").mockImplementationOnce(async () => {
        await close();
        throw providerFailure;
      });
      const remove = vi.spyOn(fs, "rm").mockRejectedValueOnce(authFailure);
      try {
        await expect(transport.cleanupAfterGatewayStop?.()).rejects.toMatchObject({
          errors: [providerFailure, authFailure],
        });
      } finally {
        remove.mockRestore();
        await fs.rm(authDir, { recursive: true, force: true });
        await close();
      }
    });
  });
});
