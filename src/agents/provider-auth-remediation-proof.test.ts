import { describe, expect, it } from "vitest";
import {
  buildEmployeeOpenAIAuthEnrollmentDesign,
  createTeamsSmokeProofTrace,
  summarizeProviderAuthRuntimeInjection,
} from "./provider-auth-remediation-proof.js";

describe("provider auth remediation proof helpers", () => {
  it("describes employee OpenAI enrollment without chat credential collection", () => {
    const design = buildEmployeeOpenAIAuthEnrollmentDesign({
      agentId: "r-harris",
      profileId: "openai:r-harris",
      secureEntrySurface: "host-owned masked credential entry",
    });

    expect(design).toMatchObject({
      agentId: "r-harris",
      provider: "openai",
      chatCredentialCollectionAllowed: false,
      valueExposureAllowed: false,
    });
    expect(JSON.stringify(design)).not.toContain("openai:r-harris");
    expect(JSON.stringify(design).toLowerCase()).not.toContain("paste");
  });

  it("summarizes runtime auth injection with only source class and booleans", () => {
    const summary = summarizeProviderAuthRuntimeInjection({
      apiKey: "synthetic-openai-credential",
      profileId: "openai:r-harris",
      source: "profile:openai:r-harris",
      mode: "api-key",
    });

    expect(summary).toMatchObject({
      provider: "openai",
      sourceClass: "profile",
      mode: "api-key",
      credentialPresent: true,
      valueExposed: false,
    });
    expect(JSON.stringify(summary)).not.toContain("synthetic-openai-credential");
    expect(JSON.stringify(summary)).not.toContain("openai:r-harris");
  });

  it("captures smoke proof links without raw peer exposure", () => {
    const trace = createTeamsSmokeProofTrace({
      accountId: "default",
      conversationId: "raw-conversation-id",
      messageId: "raw-message-id",
      route: {
        agentId: "r-harris",
        matchedBy: "binding.peer",
        sessionKey: "raw-session-key",
      },
      employeeIntakeSessionVisible: true,
    });

    expect(trace).toMatchObject({
      source: "msteams.inbound.dispatch",
      handlerDecisionTrace: "redacted",
      matchedBy: "binding.peer",
      routeAgentId: "r-harris",
      employeeIntakeSessionVisible: true,
      rawPeerExposed: false,
    });
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain("raw-conversation-id");
    expect(serialized).not.toContain("raw-message-id");
    expect(serialized).not.toContain("raw-session-key");
  });
});
