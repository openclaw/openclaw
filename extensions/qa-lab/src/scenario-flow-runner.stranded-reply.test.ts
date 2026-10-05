import type {
  QaBusInboundMessageInput,
  QaBusOutboundMessageInput,
} from "openclaw/plugin-sdk/qa-channel-protocol";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { waitForOutboundMessage } from "./suite-runtime-transport.js";

const diagnostic = "I generated a reply but could not deliver it to this chat. Please try again.";
const rawMarker = "QA-STRANDED-RETRY-FAIL-RAW";
const retryRequest = { allInputText: `${rawMarker}: you did not call message(action=send)` };

async function runStrandedRetryFailureFlow(
  options: {
    outbound?: Partial<QaBusOutboundMessageInput>;
    duplicate?: boolean;
    leakRaw?: boolean;
    extraRetry?: "immediate" | "settled";
  } = {},
) {
  const state = createQaBusState();
  const outbound = {
    accountId: "default",
    to: "dm:qa-stranded-retry-failure-dm",
    isError: true,
    text: diagnostic,
    ...options.outbound,
  };
  const requests = [{ allInputText: rawMarker }, retryRequest];
  if (options.extraRetry === "immediate") {
    requests.push(retryRequest);
  }
  let settled = false;
  return await runLoadedScenarioFlow("message-tool-stranded-final-retry-failure", {
    state,
    api: {
      env: {
        providerMode: "mock-openai",
        mock: { baseUrl: "http://qa.invalid" },
        transport: { accountId: "default" },
      },
      transport: {
        sendInbound: async (input: QaBusInboundMessageInput) => {
          const inbound = state.addInboundMessage(input);
          state.addOutboundMessage(outbound);
          return inbound;
        },
      },
      // The loaded scenario must observe its expected error without weakening success-only waits.
      waitForOutboundMessage,
      fetchJson: async (url: string) =>
        new URL(url).pathname === "/debug/request-cursor"
          ? { cursor: 0 }
          : settled && options.extraRetry === "settled"
            ? [...requests, retryRequest]
            : requests,
      sleep: async () => {
        settled = true;
        if (options.duplicate) {
          state.addOutboundMessage(outbound);
        }
        if (options.leakRaw) {
          state.addOutboundMessage({ ...outbound, text: rawMarker });
        }
      },
    },
  });
}

describe("stranded-final retry failure scenario", () => {
  it("accepts the classified diagnostic and completes its retry and privacy assertions", async () => {
    const result = await runStrandedRetryFailureFlow();
    expect(result).toMatchObject({
      status: "pass",
      steps: [{ status: "pass", details: "diagnostic=1; rawOutbound=0; retryRequests=1" }],
    });
  });

  it.each<
    [label: string, options: Parameters<typeof runStrandedRetryFailureFlow>[0], failure?: string]
  >([
    ["unclassified", { outbound: { isError: false } }],
    ["foreign account", { outbound: { accountId: "other" } }],
    ["foreign conversation", { outbound: { to: "dm:other" } }],
    ["wrong conversation kind", { outbound: { to: "channel:qa-stranded-retry-failure-dm" } }],
    ["extra text", { outbound: { text: `${diagnostic} Unexpected extra text.` } }],
    ["late duplicate", { duplicate: true }, "expected exactly one sanitized diagnostic, saw 2"],
    ["late private text leak", { leakRaw: true }, "raw stranded final text must not be delivered"],
    [
      "immediate second retry",
      { extraRetry: "immediate" },
      "expected exactly one stranded-reply retry request, saw 2",
    ],
    [
      "late second retry",
      { extraRetry: "settled" },
      "recovery must stop after retry failure: expected one retry request after settling, saw 2",
    ],
  ])("rejects %s evidence", async (_label, options, failure) => {
    await expect(runStrandedRetryFailureFlow(options)).rejects.toThrow(
      failure ??
        "expected one classified delivery failure on the original account and conversation",
    );
  });
});
