import {
  type DecisionBatchV2,
  decisionResultV2ToV1,
  type DecisionProviderV1,
  type DecisionProviderV2,
} from "openclaw/plugin-sdk/decisions";
import { hasCredentials, type RuntimeConfig } from "./config.js";

/** Existing wire fixtures speak V1; exercise the registered V2 executor with prepared facts.
 * Real catalog/credential preparation is covered by the core registered-plugin integration test. */
export function legacyWireFixture(
  provider: DecisionProviderV1 | DecisionProviderV2,
  getConfig: () => RuntimeConfig,
): DecisionProviderV1 {
  if (provider.contractVersion !== 2) {
    throw new Error("Expected the prepared executor");
  }
  return {
    id: provider.id,
    contractVersion: 1,
    isReady: () => hasCredentials(getConfig()),
    async evaluate(batch, context) {
      // Preserve hostile fixture values so the registered provider owns rejection.
      const v2: DecisionBatchV2 = {
        state:
          typeof batch.state === "string"
            ? { type: "text", text: batch.state }
            : { type: "json", value: batch.state },
        questions: batch.questions,
      };
      const config = getConfig();
      const outcome = await provider.evaluate(v2, {
        model: {
          provider: "typesafe",
          id: context.model,
          name: context.model,
          baseUrl:
            config.providerConfig?.baseUrl ??
            (config.baseUrl ? `${config.baseUrl}/v1` : "https://api.typesafe.ai/v1"),
        },
        config: {},
        auth: { mode: "api-key", apiKey: config.apiKey ?? "typesafe-local" },
        signal: context.signal,
        deadlineMonotonicMs: context.deadlineMonotonicMs,
        isAdmissible: context.isAdmissible ?? (() => true),
      });
      if (outcome.status !== "ok") {
        return outcome;
      }
      const result = decisionResultV2ToV1(v2, outcome.result);
      if (!result) {
        throw new Error("Wire fixture result was not representable in V1");
      }
      return { status: "ok", result };
    },
  };
}
