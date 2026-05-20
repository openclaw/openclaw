import { describe, expect, it } from "vitest";
import { checkA2aPeerRbac, resolveA2aPeer } from "./a2a-peer-auth.js";
import { createRbacGuard, DEFAULT_RBAC_POLICIES } from "./robot-identity.js";

describe("resolveA2aPeer", () => {
  it("resolves peer from metadata.peer_id", () => {
    const peer = resolveA2aPeer({ peer_id: "pipeline-robot" }, [
      { name: "pipeline-robot", url: "http://localhost:8001" },
    ]);
    expect("peerId" in peer && peer.peerId).toBe("pipeline-robot");
  });

  it("rejects unknown peer when whitelist configured", () => {
    const peer = resolveA2aPeer({ peer_id: "unknown" }, [
      { name: "pipeline-robot", url: "http://localhost:8001" },
    ]);
    expect("error" in peer).toBe(true);
  });
});

describe("checkA2aPeerRbac", () => {
  const guard = createRbacGuard([...DEFAULT_RBAC_POLICIES]);

  it("allows peer a2a.delegate", () => {
    const peer = {
      peerId: "pipeline-robot",
      subjectType: "peer" as const,
      subjectId: "pipeline-robot",
    };
    const result = checkA2aPeerRbac(
      { rbac: guard } as Parameters<typeof checkA2aPeerRbac>[0],
      peer,
      "a2a.delegate",
      "playbook:diagnose",
    );
    expect(result.allowed).toBe(true);
  });
});
