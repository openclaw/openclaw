import {
  createDiagnosticTraceContext,
  emitDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, test } from "vitest";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import { startOtelService } from "./service.test-helpers.js";

const sdk = installRealOtelSdkTestHarness();

test.each([
  { phase: "prepare", outcome: "ready", reason: "ready" },
  { phase: "prepare", outcome: "unavailable", reason: "off-catalog-auth-unavailable" },
  { phase: "validate", outcome: "ready", reason: "ready" },
  { phase: "validate", outcome: "unavailable", reason: "owner-stale" },
] as const)("does not export runtime-choice facts ($phase/$reason)", async (decision) => {
  const { ctx } = await startOtelService({ traces: true });
  await waitForDiagnosticEventsDrained();
  const event = {
    type: "model.runtime_choice",
    version: 1,
    ...decision,
    checks: {
      ownerLookup: "not-reached",
      authStore: "not-reached",
      catalogPresence: "not-reached",
      offCatalogAuth: "not-reached",
      offCatalogAuthMode: "not-reached",
      offCatalogResolution: "not-reached",
      runtimeEligibility: "not-reached",
      commitOwnerFreshness: "not-reached",
      nativeAvailability: "not-reached",
    },
    trace: createDiagnosticTraceContext(),
  } as const;

  emitTrustedDiagnosticEventWithPrivateData(event, {});
  emitDiagnosticEvent(event);
  await waitForDiagnosticEventsDrained();
  expect(sdk.exporter.getFinishedSpans()).toEqual([]);
  expect(ctx.logger.error).not.toHaveBeenCalled();

  // The negative assertion must not pass because the service stopped listening.
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "gateway.rpc",
      method: "health",
      phase: "response",
      outcome: "ok",
      durationMs: 1,
    },
    {},
  );
  await waitForDiagnosticEventsDrained();
  expect(sdk.exporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "openclaw.gateway.rpc.response",
  ]);
  expect(ctx.logger.error).not.toHaveBeenCalled();
});
