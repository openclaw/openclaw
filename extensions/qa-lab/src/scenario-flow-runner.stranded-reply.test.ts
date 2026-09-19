import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import type { QaBusInboundMessageInput, QaBusOutboundMessageInput } from "./runtime-api.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { waitForOutboundMessage } from "./suite-runtime-transport.js";

const diagnostic = "I generated a reply but could not deliver it to this chat. Please try again.";
const rawMarker = "QA-STRANDED-RETRY-FAIL-RAW";
const retryRequest = { allInputText: `${rawMarker}: you did not call message(action=send)` };

async function runStrandedRetryFailureFlow(
  options: {
    outbound?: Partial<QaBusOutboundMessageInput>;
    duplicate?: "immediate" | "settled";
    leakRaw?: "immediate" | "settled";
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
          if (options.duplicate === "immediate") {
            state.addOutboundMessage(outbound);
          }
          if (options.leakRaw === "immediate") {
            state.addOutboundMessage({ ...outbound, text: rawMarker });
          }
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
        if (options.duplicate === "settled") {
          state.addOutboundMessage(outbound);
        }
        if (options.leakRaw === "settled") {
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

  it.each([
    { label: "unclassified", outbound: { isError: false } },
    { label: "foreign account", outbound: { accountId: "other" } },
    { label: "foreign conversation", outbound: { to: "dm:other" } },
    { label: "wrong conversation kind", outbound: { to: "channel:qa-stranded-retry-failure-dm" } },
    { label: "extra text", outbound: { text: `${diagnostic} Unexpected extra text.` } },
  ])("rejects a $label diagnostic", async ({ outbound }) => {
    await expect(runStrandedRetryFailureFlow({ outbound })).rejects.toThrow(
      "expected one classified delivery failure on the original account and conversation",
    );
  });

  it.each([
    {
      label: "immediate duplicate",
      options: { duplicate: "immediate" as const },
      failure: "expected exactly one sanitized diagnostic, saw 2",
    },
    {
      label: "late duplicate",
      options: { duplicate: "settled" as const },
      failure: "expected exactly one sanitized diagnostic, saw 2",
    },
    {
      label: "immediate private text leak",
      options: { leakRaw: "immediate" as const },
      failure: "raw stranded final text must not be delivered",
    },
    {
      label: "late private text leak",
      options: { leakRaw: "settled" as const },
      failure: "raw stranded final text must not be delivered",
    },
    {
      label: "immediate second retry",
      options: { extraRetry: "immediate" as const },
      failure: "expected exactly one stranded-reply retry request, saw 2",
    },
    {
      label: "late second retry",
      options: { extraRetry: "settled" as const },
      failure:
        "recovery must stop after retry failure: expected one retry request after settling, saw 2",
    },
  ])("rejects $label evidence", async ({ options, failure }) => {
    await expect(runStrandedRetryFailureFlow(options)).rejects.toThrow(failure);
  });
});
