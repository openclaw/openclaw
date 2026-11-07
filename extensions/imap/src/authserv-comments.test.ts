import { authenticate } from "mailauth";
import { simpleParser } from "mailparser";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContextV2,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { expect, it, vi } from "vitest";
import imapPlugin from "../index.js";
import { createImapTestRuntime } from "./imap-test-support.js";
import { existingMail, ScriptedImapServer } from "./watcher.test-support.js";

vi.mock("mailauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mailauth")>();
  return { ...actual, authenticate: vi.fn(actual.authenticate) };
});

vi.mock("mailparser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mailparser")>();
  return { ...actual, simpleParser: vi.fn(actual.simpleParser) };
});

it("admits commented trusted assertions through the registered IMAP service", async () => {
  const server = new ScriptedImapServer();
  server.messages.push(...existingMail([1]));
  const port = await server.listen();
  const { runtime, dispatchHookAgentTurn, waitForCursor } = createImapTestRuntime();
  const registerService = vi.fn<OpenClawPluginApi["registerService"]>();
  imapPlugin.register?.(
    createTestPluginApi({
      registrationMode: "full",
      runtime,
      registerService,
      pluginConfig: {
        accounts: {
          inbox: {
            host: "127.0.0.1",
            port,
            secure: false,
            user: "fixture-user",
            password: "fixture-password",
            agentId: "mail_reader",
            allowedSenders: ["trusted@example.com"],
            senderAuth: {
              min: "asserted",
              acceptTrustedAuthservId: true,
              trustedAuthservIds: ["mx.example.com"],
            },
          },
        },
      },
    }),
  );
  const service = registerService.mock.calls[0]?.[0];
  if (service?.apiVersion !== 2) {
    await server.close();
    throw new Error("IMAP did not register its V2 watcher service");
  }
  const context: OpenClawPluginServiceContextV2 = {
    config: {},
    stateDir: "/unused-imap-fixture-state",
    scheduler: createTestPluginServiceScheduler(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  // Keep production mailauth execution, but answer DNS locally with no policy.
  const { authenticate: realAuthenticate } =
    await vi.importActual<typeof import("mailauth")>("mailauth");
  vi.mocked(authenticate).mockImplementation((source) =>
    realAuthenticate(source, {
      disableArc: true,
      disableBimi: true,
      resolver: async () => [],
    }),
  );
  dispatchHookAgentTurn.mockResolvedValue({ ok: true, runId: "fixture-run" });
  const cursor = (lastSeenUid: number) =>
    withTimeout(waitForCursor("inbox", { uidValidity: "17", lastSeenUid }), 5_000, {
      message: "Registered IMAP fixture did not settle",
    });
  try {
    await service.start(context);
    await cursor(1);
    for (const id of [
      "mx.example.com (Postfix)",
      String.raw`(receiving MTA) mx.example.com (nested (note); escaped \) delimiter) 1`,
    ]) {
      server.append(
        [
          "From: trusted@example.com",
          "To: reader@example.com",
          "Authentication-Results: " + id + "; dmarc=pass",
          "Subject: Synthetic comment fixture",
          "",
          "Synthetic task-owned mail only.",
        ].join("\r\n"),
      );
    }
    await cursor(3);
    const authResults = await Promise.all(
      vi.mocked(authenticate).mock.results.map((result) => result.value),
    );
    expect(authResults).toHaveLength(2);
    for (const result of authResults) {
      expect(result.dmarc).toMatchObject({ status: { result: "none" } });
    }
    const counts = {
      registeredServices: registerService.mock.calls.length,
      fetchedBodies: server.fetchedBodies,
      parsedMessages: vi.mocked(simpleParser).mock.calls.length,
      authenticationCalls: vi.mocked(authenticate).mock.calls.length,
      dispatchedTurns: dispatchHookAgentTurn.mock.calls.length,
      assertedAdmissions: vi
        .mocked(context.logger.info)
        .mock.calls.filter(([line]) => line.includes("strength=asserted")).length,
      rejectedAdmissions: vi
        .mocked(context.logger.warn)
        .mock.calls.filter(([line]) => line.includes("gate=")).length,
    };
    console.info("REGISTERED_IMAP_FIXTURE", JSON.stringify(counts));
    expect(counts).toEqual({
      registeredServices: 1,
      fetchedBodies: 2,
      parsedMessages: 2,
      authenticationCalls: 2,
      dispatchedTurns: 2,
      assertedAdmissions: 2,
      rejectedAdmissions: 0,
    });
  } finally {
    await service.stop?.(context);
    await server.close();
  }
});
