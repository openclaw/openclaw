import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WhatsAppQaDriverSession } from "@openclaw/whatsapp/api.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { createTempDirHarness } from "../../temp-dir.test-helper.js";
import { whatsappScenarioImplementations } from "./scenario-implementations.js";
import { runWhatsAppScenario } from "./scenario-runtime.js";
import { buildWhatsAppQaConfig } from "./whatsapp-live.config.js";
import type { WhatsAppQaMessageScenarioContext } from "./whatsapp-live.contracts.js";
import { whatsappQaPollVoteHookProofScenario } from "./whatsapp-live.scenario-implementations.poll-vote-proof.js";

const tempDirs = createTempDirHarness();
afterEach(() => tempDirs.cleanup());

function buildProofConfig(proofOutputDir: string) {
  return buildWhatsAppQaConfig(
    {},
    {
      allowFrom: ["+15550000001"],
      authDir: "/tmp/qa-sut",
      dmPolicy: "allowlist",
      ownerAllowFrom: ["+15550000001"],
      proofOutputDir,
      overrides: {
        pollVoteHookProof: {
          fixturePath: "/repo/extensions/qa-lab/test-fixtures/whatsapp-poll-vote-proof-plugin",
        },
      },
      sutAccountId: "sut",
    },
  );
}

function getConfiguredHookEventsPath(config: ReturnType<typeof buildProofConfig>) {
  const outputPath = config.plugins?.entries?.["qa-whatsapp-poll-vote-proof"]?.config?.outputPath;
  if (typeof outputPath !== "string") {
    throw new Error("WhatsApp poll-vote proof plugin has no configured output path");
  }
  return outputPath;
}

type GatewayCall = WhatsAppQaMessageScenarioContext["gateway"]["call"];

function buildContext(params: {
  artifactDir: string;
  gatewayCall: GatewayCall;
  pollMessageId: string;
}) {
  const pollVote = {
    fromJid: "15550000002@s.whatsapp.net",
    fromPhoneE164: null,
    kind: "poll_vote" as const,
    messageId: "vote-update-1",
    observedAt: new Date().toISOString(),
    pollVote: {
      pollMessageId: params.pollMessageId,
      chatJid: "15550000001@s.whatsapp.net",
      voter: "15550000002@s.whatsapp.net",
      selectedOptions: ["alpha"],
    },
    text: "",
  };
  const driver = {
    close: vi.fn(async () => undefined),
    getObservedMessages: vi.fn(() => [pollVote]),
    sendContact: vi.fn(),
    sendLocation: vi.fn(),
    sendMedia: vi.fn(),
    sendPoll: vi.fn(),
    sendReaction: vi.fn(),
    sendSticker: vi.fn(),
    sendText: vi.fn<WhatsAppQaDriverSession["sendText"]>(),
    waitForMessage: vi.fn<WhatsAppQaDriverSession["waitForMessage"]>(async () => pollVote),
  };
  const context = {
    driver,
    driverPhoneE164: "+15550000001",
    gateway: {
      call: params.gatewayCall,
      logs: () => 'poll vote received for +15550000002@s.whatsapp.net; "token":"secret-value"',
      restart: vi.fn(async () => undefined),
      workspaceDir: params.artifactDir,
    },
    gatewayTarget: "+15550000002",
    gatewayWorkspaceDir: params.artifactDir,
    proofOutputDir: params.artifactDir,
    recordObservedMessage: vi.fn(),
    requestStartedAt: new Date(),
    repoRoot: process.cwd(),
    scenarioId: "whatsapp-poll-vote-hook-proof",
    scenarioTitle: "WhatsApp poll-vote hook proof",
    sent: { messageId: "trigger-message-1" },
    sutAccountId: "sut",
    sutPhoneE164: "+15550000002",
    target: "+15550000002",
    targetKind: "dm" as const,
  } satisfies WhatsAppQaMessageScenarioContext;
  return { context, pollVote };
}

describe("WhatsApp poll-vote hook proof scenario", () => {
  it("is selectable through the live scenario registry", () => {
    const scenario = readQaScenarioById("whatsapp-poll-vote-hook-proof");

    expect(scenario.execution.config?.whatsappScenario).toBe("whatsappQaPollVoteHookProofScenario");
    expect(whatsappScenarioImplementations.whatsappQaPollVoteHookProofScenario).toBe(
      whatsappQaPollVoteHookProofScenario,
    );
  });

  it("enables the channel hook and loads the isolated fixture", () => {
    const cfg = buildProofConfig("/tmp/qa-proof");

    expect(cfg.channels?.whatsapp?.pluginHooks?.pollVoteReceived).toBe(true);
    expect(cfg.plugins?.allow).toContain("qa-whatsapp-poll-vote-proof");
    expect(cfg.plugins?.load?.paths).toContain(
      "/repo/extensions/qa-lab/test-fixtures/whatsapp-poll-vote-proof-plugin",
    );
    expect(cfg.plugins?.entries?.["qa-whatsapp-poll-vote-proof"]).toMatchObject({
      enabled: true,
      config: {
        outputPath: path.join(
          "/tmp/qa-proof",
          "whatsapp-poll-vote-hook-proof",
          "hook-events.jsonl",
        ),
      },
    });
  });

  it("uses Gateway poll send, waits for a driver vote, and writes redacted proof artifacts", async () => {
    const artifactDir = await tempDirs.makeTempDir("openclaw-whatsapp-poll-proof-");
    const pollMessageId = "gateway-poll-1";
    const proofDir = path.join(artifactDir, "whatsapp-poll-vote-hook-proof");
    const configuredHookEventsPath = getConfiguredHookEventsPath(buildProofConfig(artifactDir));
    const gatewayCall = vi.fn<GatewayCall>(async (method) => {
      expect(method).toBe("poll");
      await mkdir(path.dirname(configuredHookEventsPath), { recursive: true });
      await writeFile(
        configuredHookEventsPath,
        [
          {
            event: "poll_vote_received",
            pollMessageId: "not-the-poll",
            selectedOptions: ["alpha"],
            context: { messageId: "hook-message-1" },
          },
          {
            event: "poll_vote_received",
            pollMessageId: "d7f4861efe8dcafb",
            selectedOptions: ["alpha"],
            context: { messageId: "hook-message-2" },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      return { messageId: pollMessageId };
    });
    const { context, pollVote } = buildContext({ artifactDir, gatewayCall, pollMessageId });
    const metadata = readQaScenarioById("whatsapp-poll-vote-hook-proof");
    const implementationName = metadata.execution.config?.whatsappScenario;
    if (typeof implementationName !== "string") {
      throw new Error("Registered poll proof must select a WhatsApp implementation");
    }
    const implementation = whatsappScenarioImplementations[implementationName];
    if (!implementation) {
      throw new Error("Registered poll proof implementation is missing");
    }
    const run = implementation.buildRun();
    if (run.kind === "approval" || typeof run.matchText !== "string") {
      throw new Error("WhatsApp poll-vote proof must be a message scenario");
    }
    context.driver.sendText.mockResolvedValue({ messageId: "trigger-message-1" });
    const marker = run.matchText;
    let observationIndex = 0;
    context.driver.waitForMessage.mockImplementation(async ({ match }) => {
      const message =
        observationIndex++ === 0
          ? {
              ...pollVote,
              kind: "text" as const,
              fromPhoneE164: context.sutPhoneE164,
              observedAt: new Date(Date.now() + 1).toISOString(),
              text: marker,
            }
          : pollVote;
      expect(match(message)).toBe(true);
      return message;
    });
    const result = await runWhatsAppScenario({
      preparedScenario: { implementation, run },
      driverAuthDir: "/tmp/qa-driver",
      gateway: context.gateway as never,
      getDriver: () => context.driver,
      getProofOutputDir: () => artifactDir,
      observedMessages: [],
      repoRoot: process.cwd(),
      replaceDriver: async () => {},
      runtimeEnv: {
        driverAuthArchiveBase64: "unused",
        driverPhoneE164: context.driverPhoneE164,
        sutAuthArchiveBase64: "unused",
        sutPhoneE164: context.sutPhoneE164,
      },
      scenario: { id: metadata.id, title: metadata.title, timeoutMs: 300_000 },
      sutAccountId: context.sutAccountId,
    });

    expect(gatewayCall).toHaveBeenCalledWith(
      "poll",
      expect.objectContaining({
        options: ["alpha", "beta"],
        maxSelections: 1,
      }),
      expect.anything(),
    );
    expect(context.driver.waitForMessage).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("pass");
    expect(result.details).toContain("whatsapp-poll-vote-hook-proof");
    const proof = JSON.parse(await readFile(path.join(proofDir, "proof.json"), "utf8")) as {
      assertions: Record<string, boolean>;
      status: string;
    };
    expect(proof.status).toBe("pass");
    expect(proof.assertions).toEqual({
      isolatedQaGateway: true,
      pollVoteReceivedEnabled: true,
      gatewayPollSendAccepted: true,
      driverPollVoteObserved: true,
      hookFixtureOutputObserved: true,
    });
    expect(await readFile(path.join(proofDir, "transcript.txt"), "utf8")).not.toContain(
      "+15550000002",
    );
    expect(await readFile(path.join(proofDir, "gateway-log.txt"), "utf8")).not.toContain(
      "secret-value",
    );
  });

  it("rejects a Gateway poll response without the accepted message identifier", async () => {
    const artifactDir = await tempDirs.makeTempDir("openclaw-whatsapp-poll-proof-");
    const { context, pollVote } = buildContext({
      artifactDir,
      gatewayCall: vi.fn<GatewayCall>(async () => ({})),
      pollMessageId: "gateway-poll-1",
    });
    const run = whatsappQaPollVoteHookProofScenario.buildRun();

    if (run.kind === "approval" || !run.afterReply) {
      throw new Error("WhatsApp poll-vote proof scenario must define afterReply");
    }
    await expect(run.afterReply(pollVote, context)).rejects.toThrow(
      "Gateway poll proof requires an accepted poll messageId",
    );
  });
});
