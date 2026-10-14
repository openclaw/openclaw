import {
  consumeChannelAdmissionEvidence,
  readChannelContextAdmissionEvidence,
  withRegisteredChannelIngress,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { prepareWhatsAppInboundContext } from "../auto-reply/monitor/inbound-dispatch.js";
import { whatsappPlugin } from "../channel.js";
import { setWhatsAppRuntime } from "../runtime.js";
import { checkInboundAccessControl } from "./access-control.js";
import { createTestWebInboundMessage } from "./test-message.test-helper.js";

const sender = "+15550000001";
const cfg: OpenClawConfig = {
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: [sender],
      groupPolicy: "allowlist",
      groupAllowFrom: [sender],
    },
  },
};

describe("WhatsApp participant admission", () => {
  it("retains one person across DM, group, and plugin replacement while rejecting retired evidence", async () => {
    let principal: string | undefined;
    for (let generation = 0; generation < 2; generation++) {
      await withRegisteredChannelIngress(
        { plugin: whatsappPlugin, config: cfg, setRuntime: setWhatsAppRuntime },
        async (runtime, retire) => {
          const prepare = async (group: boolean, retireBeforeContext = false) => {
            const conversationId = group ? "120363000000000000@g.us" : sender;
            const access = await checkInboundAccessControl({
              cfg,
              accountId: "default",
              from: conversationId,
              selfE164: "+15550000002",
              senderE164: sender,
              senderJid: "15550000001@s.whatsapp.net",
              group,
              isFromMe: false,
              remoteJid: group ? conversationId : "15550000001@s.whatsapp.net",
              sock: { sendMessage: async () => undefined },
            });
            expect(access.allowed).toBe(true);
            if (!access.allowed) {
              throw new Error("Expected admitted WhatsApp fixture");
            }
            const msg = createTestWebInboundMessage();
            msg.admission = access.admission;
            const buildContext = runtime.channel.inbound.buildContext;
            if (retireBeforeContext) {
              retire();
            }
            return await prepareWhatsAppInboundContext({
              combinedBody: "hello",
              msg,
              sender: { id: sender, e164: sender },
              route: {
                agentId: "main",
                channel: "whatsapp",
                accountId: "default",
                sessionKey: `agent:main:whatsapp:${group ? "group" : "direct"}:fixture`,
                mainSessionKey: "agent:main:main",
                lastRoutePolicy: "session",
                matchedBy: "default",
              },
              buildContext,
            });
          };
          for (const group of [false, true]) {
            const prepared = await prepare(group);
            const evidence = readChannelContextAdmissionEvidence(prepared.ctxPayload);
            const consumed = consumeChannelAdmissionEvidence(evidence);
            expect(consumed).toMatchObject({
              ingressState: "present",
              invoker: { state: "present", kind: "person" },
              decisionCoverage: "enforced",
            });
            if (consumed.invoker.state === "present") {
              principal ??= consumed.invoker.rawPrincipalRef;
              expect(consumed.invoker.rawPrincipalRef === principal).toBe(true);
            }
            expect(consumeChannelAdmissionEvidence(evidence)).toMatchObject({
              ingressState: "unknown",
              invoker: { state: "unknown" },
            });
          }
          const stale = await prepare(false, true);
          expect(
            consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(stale.ctxPayload)),
          ).toMatchObject({ ingressState: "unknown", invoker: { state: "unknown" } });
        },
      );
    }
  });
});
