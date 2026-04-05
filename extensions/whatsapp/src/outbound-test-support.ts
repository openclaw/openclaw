import type { MullusiConfig } from "mullusi/plugin-sdk/config-runtime";
import { expect, type MockInstance } from "vitest";

export function createWhatsAppPollFixture() {
  const cfg = { marker: "resolved-cfg" } as MullusiConfig;
  const poll = {
    question: "Lunch?",
    options: ["Pizza", "Sushi"],
    maxSelections: 1,
  };
  return {
    cfg,
    poll,
    to: "+1555",
    accountId: "work",
  };
}

export function expectWhatsAppPollSent(
  sendPollWhatsApp: MockInstance,
  params: {
    cfg: MullusiConfig;
    poll: { question: string; options: string[]; maxSelections: number };
    to?: string;
    accountId?: string;
  },
) {
  expect(sendPollWhatsApp).toHaveBeenCalledWith(params.to ?? "+1555", params.poll, {
    verbose: false,
    accountId: params.accountId ?? "work",
    cfg: params.cfg,
  });
}
