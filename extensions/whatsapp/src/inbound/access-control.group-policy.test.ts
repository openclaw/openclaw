import { describe } from "vitest";
import { installProviderRuntimeGroupPolicyFallbackSuite } from "../../../../src/test-utils/runtime-group-policy-contract.js";
import { __testing } from "./access-control.js";

describe("resolveWhatsAppRuntimeGroupPolicy", () => {
  installProviderRuntimeGroupPolicyFallbackSuite({
    resolve: __testing.resolveWhatsAppRuntimeGroupPolicy,
    configuredLabel: "keeps open fallback when channels.whatsapp is configured",
    defaultGroupPolicyUnderTest: "disabled",
    missingConfigLabel: "fails closed when channels.whatsapp is missing and no defaults are set",
    missingDefaultLabel: "ignores explicit default policy when provider config is missing",
  });
});
