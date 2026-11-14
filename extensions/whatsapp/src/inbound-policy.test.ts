import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { normalizeTestWhatsAppMessage } from "./inbound/message-normalization.test-helper.js";
import { setWhatsAppRuntime } from "./runtime.js";

describe("WhatsApp transport identity", () => {
  it.each([false, true])("retains a verified primary sender in group=%s ingress", async (group) => {
    setWhatsAppRuntime(createPluginRuntimeMock());
    const phone = "+15550001111";
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: [phone],
          groupPolicy: "allowlist",
          groupAllowFrom: [phone],
        },
      },
    };
    const message = await normalizeTestWhatsAppMessage({
      cfg,
      group,
      from: group ? "120363401234567890@g.us" : phone,
      senderE164: phone,
    });
    expect(message).not.toBeNull();
    const ingress = message!.access.admission.channelIngress!;
    expect(ingress.senderAccess.allowed).toBe(true);
    const allowlist = group ? ingress.state.allowlists.group : ingress.state.allowlists.dm;
    expect(allowlist).toMatchObject({
      normalizedEntries: [{ kind: "stable-id", sensitivity: "pii" }],
      match: { matchedPairs: [{ subjectAuthentication: "verified" }] },
    });
  });
});
