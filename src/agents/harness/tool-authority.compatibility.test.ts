import { afterEach, describe, expect, it } from "vitest";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import {
  beginReplyMessageInjectionTarget,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { resolveInboundReplyToolAuthorityOverlay } from "../../auto-reply/reply/reply-tool-authority-inbound.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { testing } from "../embedded-agent-runner/runs.test-support.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { attempt, own, published, sessionKey } from "./tool-authority.runtime.test-support.js";

afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetReplyRunRegistry();
});

describe("frozen execution capability steering", () => {
  it.each([
    "normal-web",
    "headless-recovery",
    "caps-only",
    "protocol-only",
    "target-only",
    "binding-change",
    "ui-to-headless",
    "target-removal",
    "cross-profile-caps",
    "non-own-target-rebind",
    "lower-privilege",
    "revoked",
  ] as const)(
    "qualifies inbound steering against frozen execution capabilities: %s",
    async (scenario) => {
      const modelPolicy = prepareOperatorModelPolicy({ cfg: {}, policy: {} });
      const authority = (incoming = false) =>
        createAdmittedRunOperatorAuthority({
          profileId:
            incoming && scenario === "cross-profile-caps" ? "synthetic-other" : "synthetic-owner",
          scopes:
            incoming && scenario === "lower-privilege"
              ? ["operator.read"]
              : ["operator.read", "operator.write", "operator.admin"],
          gatewayAccessGrant: null,
          modelPolicy,
          assertCurrent() {
            if (incoming && scenario === "revoked") {
              throw new Error("Synthetic incoming authority revoked");
            }
          },
        });
      const headless = ["headless-recovery", "caps-only", "cross-profile-caps"].includes(scenario);
      const noOriginalTarget = headless || scenario === "target-only";
      const targetProfile =
        scenario === "non-own-target-rebind" ? "synthetic-target" : "synthetic-owner";
      const accepts = [
        "normal-web",
        "headless-recovery",
        "caps-only",
        "protocol-only",
        "target-only",
      ].includes(scenario);
      await published(
        async ({ handle, queue }) => {
          const originalFingerprint = handle.toolAuthorityFingerprint;
          const originalParticipant =
            getGatewayToolCallerIdentity()?.personalToolParticipants?.resolve();
          expect(originalParticipant).toBeDefined();
          handle.supportsTranscriptCommitWait = true;
          handle.terminalReplyExpectation = "required";
          handle.messageInjectionV2 = {
            version: 2,
            isAvailable: () => true,
            queueMessage: async (text, options, assertCurrent) => {
              assertCurrent();
              return queue(text, options);
            },
          };
          const overlay = resolveInboundReplyToolAuthorityOverlay({
            ctx: finalizeInboundContext({
              Provider: "webchat",
              Surface: "webchat",
              OriginatingChannel: "webchat",
              ChatType: "direct",
              GatewayClientScopes: ["operator.admin"],
              GatewayClientCaps:
                scenario === "ui-to-headless"
                  ? []
                  : scenario === "protocol-only"
                    ? ["ui-commands", "usage-refreshing"]
                    : ["headless-recovery", "caps-only"].includes(scenario)
                      ? [
                          "agent-kind",
                          "approvals",
                          "task-suggestions",
                          "terminal-offset-seq",
                          "terminal-session-metadata",
                          "terminal-upload-path-style",
                          "tool-events",
                          "chat-only-assistant-text",
                          "session-scoped-events",
                          "inline-widgets",
                          "model-selection-policy",
                          "ui-commands",
                          "ultrafast",
                          "usage-refreshing",
                        ]
                      : ["ui-commands"],
              GatewayUiCommandTarget: ["caps-only", "ui-to-headless", "target-removal"].includes(
                scenario,
              )
                ? undefined
                : { connId: "synthetic-current", profileId: targetProfile },
              GatewayRunToolBindings:
                scenario === "binding-change" ? { synthetic: "changed" } : undefined,
            }),
            senderIsOwner: true,
            operatorAuthority: authority(true),
            disableTools: false,
          });
          const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey);
          if (!target) {
            throw new Error("Expected real direct target");
          }
          const injection = await beginReplyMessageInjectionTarget(target, "Synthetic correction", {
            isInboundUserMessage: true,
            toolAuthorityOverlay: overlay,
          });
          await expect(injection.outcome).resolves.toMatchObject(
            accepts
              ? { status: "accepted" }
              : { status: "rejected", reason: "tool_authority_mismatch" },
          );
          expect(queue).toHaveBeenCalledTimes(accepts ? 1 : 0);
          if (accepts) {
            expect(queue).toHaveBeenCalledWith("Synthetic correction", expect.anything());
          }
          expect(handle.toolAuthorityFingerprint).toBe(originalFingerprint);
          const retainedParticipant =
            getGatewayToolCallerIdentity()?.personalToolParticipants?.resolve();
          expect(retainedParticipant?.gatewayUiCommandTarget).toEqual(
            originalParticipant?.gatewayUiCommandTarget,
          );
          if (noOriginalTarget) {
            expect(retainedParticipant?.gatewayUiCommandTarget).toBeUndefined();
          }
        },
        {
          messageChannel: "webchat",
          chatType: "direct",
          clientCaps: headless ? [] : ["ui-commands"],
          gatewayUiCommandTarget: noOriginalTarget
            ? undefined
            : { connId: "synthetic-original", profileId: targetProfile },
        },
        authority(),
      );
    },
  );

  it("shares frozen capability projection across async and prepared synchronous reads", async () => {
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "synthetic-owner",
      scopes: ["operator.read", "operator.write"],
      gatewayAccessGrant: null,
      modelPolicy: prepareOperatorModelPolicy({ cfg: {}, policy: {} }),
      assertCurrent() {},
    });
    const authority = prepareReplyToolAuthority({
      operatorAuthority,
      run: { ...attempt, model: attempt.modelId, clientCaps: [] },
    });
    const route = { provider: attempt.provider, model: attempt.modelId };
    try {
      const original = await authority.fingerprintAsync(route);
      const incoming = {
        ...own,
        operatorAuthority,
        clientCaps: ["ui-commands"],
        gatewayUiCommandTarget: { connId: "synthetic-current", profileId: "synthetic-owner" },
      };
      expect(await authority.projectAsync(incoming, route)).toBe(original);
      expect(authority.project(incoming, route)).toBe(original);
      expect(await authority.fingerprintAsync(route)).toBe(original);
      expect(authority.fingerprint(route)).toBe(original);
    } finally {
      authority.close();
    }
  });
});
