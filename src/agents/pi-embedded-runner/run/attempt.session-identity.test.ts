import { describe, expect, it } from "vitest";
import { resolveCanonicalRunnerSessionIdentity } from "./attempt.js";

describe("resolveCanonicalRunnerSessionIdentity", () => {
  it("does not let runner resolve default session into another agent namespace", () => {
    expect(
      resolveCanonicalRunnerSessionIdentity({
        sessionKey: "main",
        sessionAgentId: "legal",
        mainKey: "main",
      }).canonicalSessionKey,
    ).toBe("agent:legal:main");

    expect(
      resolveCanonicalRunnerSessionIdentity({
        sessionKey: "main",
        sessionAgentId: "design",
        mainKey: "main",
      }).canonicalSessionKey,
    ).toBe("agent:design:main");
  });

  it("keeps agent a and agent b isolated for lookup", () => {
    const a = resolveCanonicalRunnerSessionIdentity({
      sessionKey: "chat:123",
      sessionAgentId: "a",
      mainKey: "main",
    }).canonicalSessionKey;
    const b = resolveCanonicalRunnerSessionIdentity({
      sessionKey: "chat:123",
      sessionAgentId: "b",
      mainKey: "main",
    }).canonicalSessionKey;

    expect(a).toBe("agent:a:chat:123");
    expect(b).toBe("agent:b:chat:123");
    expect(a).not.toBe(b);
  });
});
