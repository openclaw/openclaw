import { describe } from "vitest";
import { installProviderRuntimeGroupPolicyFallbackSuite } from "../../../src/test-utils/runtime-group-policy-contract.js";
import { resolveTelegramRuntimeGroupPolicy } from "./group-access.js";

describe("resolveTelegramRuntimeGroupPolicy", () => {
  installProviderRuntimeGroupPolicyFallbackSuite({
    resolve: resolveTelegramRuntimeGroupPolicy,
    configuredLabel: "keeps open fallback when channels.telegram is configured",
    defaultGroupPolicyUnderTest: "disabled",
    missingConfigLabel: "fails closed when channels.telegram is missing and no defaults are set",
    missingDefaultLabel: "ignores explicit defaults when provider config is missing",
  });
});
