import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { toStringifiedError } from "openclaw/plugin-sdk/error-runtime";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "../shared/credential-lease.runtime.js";
import { createDiscordChannelE2eSession, type DiscordChannelE2eSession } from "./channel-e2e.js";
import { discordQaScenarioSupport } from "./discord-live.runtime.js";
import { createDiscordQaScenarioEnvironment } from "./scenario-environment.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;

function discordSnowflakeForTimestamp(timestampMs: number) {
  // Seed the cursor at adapter startup so old channel history is not replayed into the QA bus.
  return (BigInt(timestampMs - 1_420_070_400_000) << 22n).toString();
}

export async function createDiscordQaTransportAdapter(
  context: FactoryContext,
): Promise<AdapterDefinition> {
  const options = context.adapterOptions ?? {};
  const lease = await acquireQaCredentialLease({
    kind: "discord",
    source: options.credentialSource,
    role: options.credentialRole,
    cwd: options.repoRoot,
    resolveEnvPayload: () => discordQaScenarioSupport.testing.resolveDiscordQaRuntimeEnv(),
    parsePayload: discordQaScenarioSupport.testing.parseDiscordQaCredentialPayload,
  });
  const heartbeat = startQaCredentialLeaseHeartbeat(lease);
  const runtimeEnv = lease.payload;
  let driverIdentity: Awaited<
    ReturnType<typeof discordQaScenarioSupport.testing.getCurrentDiscordUser>
  >;
  let sutIdentity: Awaited<
    ReturnType<typeof discordQaScenarioSupport.testing.getCurrentDiscordUser>
  >;
  try {
    heartbeat.throwIfFailed();
    [driverIdentity, sutIdentity] = await Promise.all([
      discordQaScenarioSupport.testing.getCurrentDiscordUser(runtimeEnv.driverBotToken),
      discordQaScenarioSupport.testing.getCurrentDiscordUser(runtimeEnv.sutBotToken),
    ]);
    heartbeat.throwIfFailed();
    if (driverIdentity.id === sutIdentity.id) {
      throw new Error("Discord QA requires two distinct bots for driver and SUT.");
    }
    if (sutIdentity.id !== runtimeEnv.sutApplicationId) {
      throw new Error("Discord QA SUT application id must match the SUT bot user id.");
    }
  } catch (error) {
    try {
      await heartbeat.stop();
    } finally {
      await lease.release();
    }
    throw error;
  }
  const accountId = options.sutAccountId?.trim() || "sut";
  let stopped = false;
  const e2eSessions: DiscordChannelE2eSession[] = [];
  let activeE2eSession: DiscordChannelE2eSession | undefined;
  const assertActive = () => {
    heartbeat.throwIfFailed();
    if (stopped) {
      throw new Error("Discord QA adapter is stopped");
    }
  };
  const waitReady: AdapterDefinition["waitReady"] = async ({ gateway }) => {
    assertActive();
    await discordQaScenarioSupport.testing.waitForDiscordChannelRunning(
      gateway as never,
      accountId,
    );
    assertActive();
  };
  let pollingError: Error | undefined;
  let afterSnowflake = discordSnowflakeForTimestamp(Date.now());
  const polling = (async () => {
    for (;;) {
      if (stopped) {
        return;
      }
      try {
        assertActive();
        const observed: Parameters<
          typeof discordQaScenarioSupport.testing.pollChannelMessages
        >[0]["observedMessages"] = [];
        const matched = await discordQaScenarioSupport.testing.pollChannelMessages({
          token: runtimeEnv.driverBotToken,
          channelId: runtimeEnv.channelId,
          afterSnowflake,
          timeoutMs: 1_500,
          observedMessages: observed,
          observationScenarioId: "adapter",
          observationScenarioTitle: "Discord adapter",
          predicate: (message: { senderId: string }) => message.senderId === sutIdentity.id,
        });
        assertActive();
        afterSnowflake = matched.afterSnowflake;
        await context.messages.addOutboundMessage({
          accountId,
          to: `channel:${runtimeEnv.channelId}`,
          senderId: sutIdentity.id,
          text: matched.message.text,
          timestamp: matched.message.timestamp ? Date.parse(matched.message.timestamp) : Date.now(),
        });
      } catch (error) {
        if (!String(error).includes("timed out after")) {
          throw error;
        }
      }
      await sleep(250);
    }
  })().catch((error: unknown) => {
    if (!stopped) {
      pollingError = toStringifiedError(error);
    }
  });
  const scenarioEnvironment = createDiscordQaScenarioEnvironment({
    accountId,
    driverIdentity,
    runtimeEnv,
    sutIdentity,
  });
  return {
    id: "discord",
    label: "Discord live",
    accountId,
    requiredPluginIds: ["discord"],
    supportedActions: [],
    ...(options.agentE2e ? { whenUnhealthy: heartbeat.whenFailed } : {}),
    assertTransportHealthy() {
      assertActive();
      if (pollingError) {
        throw pollingError;
      }
      activeE2eSession?.assertHealthy();
    },
    async sendInbound(input) {
      assertActive();
      if (options.agentE2e) {
        if (!activeE2eSession) {
          throw new Error("Discord agent E2E inbound requires a prepared scenario");
        }
        await activeE2eSession.driver.send({
          text: input.text,
          mention: input.text.includes("@openclaw"),
        });
        assertActive();
        return await context.messages.addInboundMessage({
          ...input,
          accountId,
          senderId: driverIdentity.id,
        });
      }
      const text = input.text.replaceAll("@openclaw", `<@${runtimeEnv.sutApplicationId}>`);
      const sent = await discordQaScenarioSupport.testing.sendChannelMessage(
        runtimeEnv.driverBotToken,
        runtimeEnv.channelId,
        text,
      );
      assertActive();
      afterSnowflake = sent.id;
      return await context.messages.addInboundMessage({
        ...input,
        accountId,
        senderId: driverIdentity.id,
      });
    },
    resetTransport: () => undefined,
    createGatewayConfig: () =>
      discordQaScenarioSupport.testing.buildDiscordQaConfig({} as OpenClawConfig, {
        guildId: runtimeEnv.guildId,
        channelId: runtimeEnv.channelId,
        driverBotId: driverIdentity.id,
        sutAccountId: accountId,
        sutBotToken: runtimeEnv.sutBotToken,
      }),
    async prepareFlow(input) {
      assertActive();
      input.signal?.throwIfAborted();
      const prepared = await scenarioEnvironment.prepareFlow(input);
      assertActive();
      input.signal?.throwIfAborted();
      if (!options.agentE2e) {
        return prepared;
      }
      const session = createDiscordChannelE2eSession({
        runtimeEnv,
        driverId: driverIdentity.id,
        sutId: sutIdentity.id,
        outputDir: input.outputDir,
        scenarioId: input.scenarioId,
        signal: input.signal,
        assertActive,
        assertLeaseActive: () => heartbeat.throwIfFailed(),
        waitForSutReady: async () => {
          await waitReady({ gateway: input.gateway });
          input.signal?.throwIfAborted();
        },
      });
      e2eSessions.push(session);
      activeE2eSession = session;
      const readiness = await session.driver.doctor();
      if (!readiness.ok) {
        throw new Error(
          `Discord E2E readiness failed: ${readiness.checks
            .filter((check) => !check.ok)
            .map((check) => check.detail)
            .join("; ")}`,
        );
      }
      return { ...prepared, channelE2e: session.driver };
    },
    waitReady,
    buildAgentDelivery: () => ({
      channel: "discord",
      to: `channel:${runtimeEnv.channelId}`,
      replyChannel: "discord",
      replyTo: `channel:${runtimeEnv.channelId}`,
    }),
    async handleAction() {
      throw new Error("Discord live QA adapter does not implement transport actions");
    },
    createReportNotes: () => ["Uses the Discord live adapter."],
    async cleanup() {
      stopped = true;
      await Promise.all(e2eSessions.map((session) => session.stop()));
      await polling.catch(() => undefined);
    },
    async cleanupAfterGatewayStop() {
      const failures: unknown[] = [];
      for (const session of e2eSessions) {
        try {
          await session.cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await heartbeat.stop();
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          await lease.release();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length) {
        throw new AggregateError(failures, "Discord QA cleanup failed");
      }
    },
  };
}
