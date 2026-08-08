// Qa Lab tests cover the Discord runtime-context live scenario contract.
import { describe, expect, it, vi } from "vitest";
import { buildQaGatewayConfig } from "../../qa-gateway-config.js";
import { discordQaRuntimeContextRedactionScenario } from "./discord-live.runtime.js";
import type { DiscordQaScenarioEnvironment } from "./scenario-environment.js";
import { runDiscordRuntimeContextRedactionProof, runDiscordScenario } from "./scenario-runtime.js";

function createRuntimeContextHarness(
  options: {
    delaySanitizedWrapperOnlyUntilFinalQuietWindow?: boolean;
    delaySanitizedWrapperOnlyUntilMixed?: boolean;
    delayWrapperOnlyUntilMixed?: boolean;
    leakWrapperOnly?: boolean;
  } = {},
) {
  const sessionMessages: unknown[] = [];
  let delayedWrapperOnlyContent: string | undefined;
  let mixedVisibleTurnObserved = false;
  let messageSequence = 0;
  const deletedMessageIds: string[] = [];
  const deleteMessage = vi.fn(async (messageId: string) => {
    deletedMessageIds.push(messageId);
  });
  const nextMessage = () => ({ id: `message-${++messageSequence}` });
  return {
    deletedMessageIds,
    deleteMessage,
    dependencies: {
      createMarker: (prefix: string) => `${prefix}_SECRET_MARKER`,
      deleteMessage,
      readSessionMessages: async () => {
        const snapshot = [...sessionMessages];
        if (
          options.delaySanitizedWrapperOnlyUntilFinalQuietWindow &&
          delayedWrapperOnlyContent !== undefined &&
          snapshot.some(
            (message) =>
              message !== null &&
              typeof message === "object" &&
              "content" in message &&
              (message as { content?: unknown }).content === "VISIBLE_TEXT_SECRET_MARKER",
          )
        ) {
          mixedVisibleTurnObserved = true;
        }
        return snapshot;
      },
      sendImage: async () => {
        sessionMessages.push({ role: "user", content: "<media:image>" });
        return nextMessage();
      },
      sendText: async (content: string) => {
        if (content.startsWith("VISIBLE_TEXT_SECRET_MARKER")) {
          if (
            delayedWrapperOnlyContent !== undefined &&
            !options.delaySanitizedWrapperOnlyUntilFinalQuietWindow
          ) {
            sessionMessages.push({ role: "user", content: delayedWrapperOnlyContent });
            delayedWrapperOnlyContent = undefined;
          }
          sessionMessages.push({ role: "user", content: "VISIBLE_TEXT_SECRET_MARKER" });
        } else if (options.delaySanitizedWrapperOnlyUntilFinalQuietWindow) {
          delayedWrapperOnlyContent = "";
        } else if (options.delaySanitizedWrapperOnlyUntilMixed) {
          delayedWrapperOnlyContent = "";
        } else if (options.delayWrapperOnlyUntilMixed) {
          delayedWrapperOnlyContent = content;
        } else if (options.leakWrapperOnly) {
          sessionMessages.push({ role: "user", content });
        }
        return nextMessage();
      },
      sleep: async () => {
        if (mixedVisibleTurnObserved && delayedWrapperOnlyContent !== undefined) {
          sessionMessages.push({ role: "user", content: delayedWrapperOnlyContent });
          delayedWrapperOnlyContent = undefined;
        }
      },
    },
  };
}

function readErrorChain(error: unknown) {
  const chain: Error[] = [];
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = current.cause;
  }
  return chain;
}

describe("Discord runtime-context redaction scenario", () => {
  it("proves all three session contracts without putting markers in evidence", async () => {
    const harness = createRuntimeContextHarness();

    const proof = await runDiscordRuntimeContextRedactionProof({
      dependencies: harness.dependencies,
      noTurnWindowMs: 0,
      turnTimeoutMs: 10,
    });

    expect(proof.pass).toBe(true);
    expect(proof.cases).toEqual([
      {
        id: "wrapper-only-text-dropped",
        checks: {
          finalUserTurnCountMatchesExpected: true,
          userTurnCountUnchanged: true,
          wrapperMarkerAbsent: true,
        },
        pass: true,
      },
      {
        id: "wrapper-only-image-keeps-native-fallback",
        checks: { nativeImageFallbackPresent: true, wrapperMarkerAbsent: true },
        pass: true,
      },
      {
        id: "mixed-visible-text-kept-wrapper-dropped",
        checks: { visibleTextPresent: true, wrapperMarkerAbsent: true },
        pass: true,
      },
    ]);
    expect(JSON.stringify(proof)).not.toContain("SECRET_MARKER");
    expect(harness.deletedMessageIds).toEqual(["message-3", "message-2", "message-1"]);
  });

  it("reports a wrapper-only session leak while still cleaning every message", async () => {
    const harness = createRuntimeContextHarness({ leakWrapperOnly: true });

    const proof = await runDiscordRuntimeContextRedactionProof({
      dependencies: harness.dependencies,
      noTurnWindowMs: 0,
      turnTimeoutMs: 10,
    });

    expect(proof.pass).toBe(false);
    expect(proof.cases[0]).toEqual({
      id: "wrapper-only-text-dropped",
      checks: {
        finalUserTurnCountMatchesExpected: false,
        userTurnCountUnchanged: false,
        wrapperMarkerAbsent: false,
      },
      pass: false,
    });
    expect(harness.deletedMessageIds).toEqual(["message-3", "message-2", "message-1"]);
  });

  it("rejects a wrapper-only session turn that arrives during a later case", async () => {
    const harness = createRuntimeContextHarness({ delayWrapperOnlyUntilMixed: true });

    const proof = await runDiscordRuntimeContextRedactionProof({
      dependencies: harness.dependencies,
      noTurnWindowMs: 0,
      turnTimeoutMs: 10,
    });

    expect(proof.pass).toBe(false);
    expect(proof.cases[0]).toEqual({
      id: "wrapper-only-text-dropped",
      checks: {
        finalUserTurnCountMatchesExpected: false,
        userTurnCountUnchanged: true,
        wrapperMarkerAbsent: false,
      },
      pass: false,
    });
    expect(harness.deletedMessageIds).toEqual(["message-3", "message-2", "message-1"]);
  });

  it("rejects a delayed sanitized empty wrapper-only user turn", async () => {
    const harness = createRuntimeContextHarness({ delaySanitizedWrapperOnlyUntilMixed: true });

    const proof = await runDiscordRuntimeContextRedactionProof({
      dependencies: harness.dependencies,
      noTurnWindowMs: 0,
      turnTimeoutMs: 10,
    });

    expect(proof.pass).toBe(false);
    expect(proof.cases[0]).toEqual({
      id: "wrapper-only-text-dropped",
      checks: {
        finalUserTurnCountMatchesExpected: false,
        userTurnCountUnchanged: true,
        wrapperMarkerAbsent: true,
      },
      pass: false,
    });
    expect(harness.deletedMessageIds).toEqual(["message-3", "message-2", "message-1"]);
  });

  it("rejects a sanitized empty wrapper-only turn released in the final quiet window", async () => {
    const harness = createRuntimeContextHarness({
      delaySanitizedWrapperOnlyUntilFinalQuietWindow: true,
    });

    const proof = await runDiscordRuntimeContextRedactionProof({
      dependencies: harness.dependencies,
      noTurnWindowMs: 0,
      turnTimeoutMs: 10,
    });

    expect(proof.pass).toBe(false);
    expect(proof.cases[0]).toEqual({
      id: "wrapper-only-text-dropped",
      checks: {
        finalUserTurnCountMatchesExpected: false,
        userTurnCountUnchanged: true,
        wrapperMarkerAbsent: true,
      },
      pass: false,
    });
    expect(harness.deletedMessageIds).toEqual(["message-3", "message-2", "message-1"]);
  });

  it("fails closed when any Discord message cannot be deleted", async () => {
    const harness = createRuntimeContextHarness();
    harness.deleteMessage.mockRejectedValueOnce(new Error("sensitive upstream failure"));

    await expect(
      runDiscordRuntimeContextRedactionProof({
        dependencies: harness.dependencies,
        noTurnWindowMs: 0,
        turnTimeoutMs: 10,
      }),
    ).rejects.toThrow("Discord runtime-context proof message cleanup failed");
    expect(harness.deleteMessage).toHaveBeenCalledTimes(3);
  });

  it("reads the routed QA session and retains only a sanitized error cause", async () => {
    const sensitive = {
      channelId: "123456789012345678",
      driverBotToken: "driver-token-secret",
      driverUserId: "223456789012345678",
      guildId: "323456789012345678",
      sutApplicationId: "423456789012345678",
      sutBotToken: "sut-token-secret",
      sutUserId: "523456789012345678",
    };
    const originalError = new Error(
      `request failed with ${sensitive.driverBotToken} in guild ${sensitive.guildId}`,
      {
        cause: new Error(
          `nested ${sensitive.sutBotToken} channel ${sensitive.channelId} app ${sensitive.sutApplicationId} users ${sensitive.driverUserId}/${sensitive.sutUserId}`,
        ),
      },
    );
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18789,
      gatewayToken: "test-token",
      workspaceDir: "/tmp/discord-runtime-context-redaction-workspace",
    });
    const environment = {
      configureScenario: async () => ({ cfg, run: { kind: "runtime-context-redaction" } }),
      driverIdentity: { id: sensitive.driverUserId },
      gateway: {
        call: vi.fn(async () => {
          throw originalError;
        }),
      },
      observedMessages: [],
      outputDir: "/tmp/discord-runtime-context-redaction-test",
      runtimeEnv: {
        channelId: sensitive.channelId,
        driverBotToken: sensitive.driverBotToken,
        guildId: sensitive.guildId,
        sutApplicationId: sensitive.sutApplicationId,
        sutBotToken: sensitive.sutBotToken,
      },
      scenario: { id: "runtime-context-redaction", timeoutMs: 10, title: "redaction" },
      sutAccountId: "default",
      sutIdentity: { id: sensitive.sutUserId },
    } as unknown as DiscordQaScenarioEnvironment;

    let failure: unknown;
    try {
      await runDiscordScenario(environment, discordQaRuntimeContextRedactionScenario);
    } catch (error) {
      failure = error;
    }

    const errorChain = readErrorChain(failure);
    expect(environment.gateway.call).toHaveBeenCalledWith("sessions.get", {
      key: `agent:qa:discord:channel:${sensitive.channelId}`,
      limit: 200,
    });
    expect(errorChain).toHaveLength(2);
    expect(errorChain[0]?.message).toBe("Discord runtime-context redaction scenario failed");
    expect(errorChain[1]?.message).toContain("<redacted>");
    expect(errorChain).not.toContain(originalError);
    expect(errorChain[1]?.cause).toBeUndefined();
    const renderedChain = errorChain
      .flatMap((error) => [error.message, error.stack ?? ""])
      .join("\n");
    for (const value of Object.values(sensitive)) {
      expect(renderedChain).not.toContain(value);
    }
  });
});
