import { expect, it } from "vitest";
import {
  assistantMessage,
  attemptResult,
  prepareAttempt,
} from "./terminal-preparation.test-support.js";

it("carries the physical request Access and account through a cyber refusal", async () => {
  const assistant = assistantMessage("stop");
  assistant.diagnostics = [
    {
      type: "provider_refusal",
      timestamp: 1,
      details: { provider: "openai", category: "cyber" },
    },
  ];
  const prepared = await prepareAttempt({
    authProfileId: "openai:pinned",
    attempt: attemptResult({ cyberAccessProgram: "daybreak_blue" }, assistant),
  });
  expect(prepared.agentMeta.providerRefusal).toMatchObject({
    provider: "openai",
    category: "cyber",
    accessProgram: "daybreak_blue",
    authProfileId: "openai:pinned",
  });
});
