// Whatsapp tests cover setup/runtime allowlist formatting parity.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { whatsappPlugin } from "./channel.js";
import { whatsappSetupPlugin } from "./channel.setup.js";

describe("WhatsApp allowlist formatting", () => {
  it("uses the same canonical formatter in setup and runtime", () => {
    const allowFrom: Array<string | number> = [
      " WhatsApp:whatsapp:+1 (555) 123-4567 ",
      "+15551234567",
      "15551230001@s.whatsapp.net",
      "15551230001:4@c.us",
      "15551230002:7@hosted",
      "15551230006_128:1@s.whatsapp.net",
      "15551230007_128:2@hosted",
      "277038292303944_1:2@s.whatsapp.net",
      "277038292303945_129:3@s.whatsapp.net",
      "*",
      15551230003,
      " ",
      "abc@s.whatsapp.net",
      "15551230004:bad@hosted",
      "15551230005@lid",
      "telegram:+15551230006",
    ];
    const params = { cfg: {} as OpenClawConfig, allowFrom };
    const expected = [
      "15551234567",
      "15551230001",
      "15551230002",
      "15551230006",
      "15551230007",
      "*",
      "15551230003",
    ];

    expect(whatsappSetupPlugin.config.formatAllowFrom?.(params)).toEqual(expected);
    expect(whatsappPlugin.config.formatAllowFrom?.(params)).toEqual(expected);
  });
});
