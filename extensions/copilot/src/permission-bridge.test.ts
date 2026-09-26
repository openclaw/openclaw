// Copilot tests cover permission bridge plugin behavior.
import type { PermissionRequest as SdkPermissionRequest } from "@github/copilot-sdk";
import { describe, expect, it, vi } from "vitest";
import { createPermissionBridge, type CopilotPermissionPolicy } from "./permission-bridge.js";

const REJECT_ALL_FEEDBACK =
  "copilot agent runtime: no permission policy installed (fail-closed default)";
function makeRequest(): SdkPermissionRequest {
  return {
    canOfferSessionApproval: false,
    commands: [],
    fullCommandText: "echo test",
    hasWriteFileRedirection: false,
    intention: "test command",
    kind: "shell",
    possiblePaths: [],
    possibleUrls: [],
    toolCallId: "call-1",
  };
}

describe("createPermissionBridge", () => {
  it("defaults to rejectAllPolicy when no policy is passed", async () => {
    const handler = createPermissionBridge();
    const result = await handler(makeRequest(), { sessionId: "sess-1" });
    expect(result).toEqual({ kind: "reject", feedback: REJECT_ALL_FEEDBACK });
  });

  it("forwards the SDK request and sessionId and returns the policy decision", async () => {
    const policy = vi.fn<CopilotPermissionPolicy>(() => ({ kind: "approve-once" }));
    const handler = createPermissionBridge(policy);
    const request = makeRequest();
    await expect(handler(request, { sessionId: "sess-xyz" })).resolves.toEqual({
      kind: "approve-once",
    });
    expect(policy).toHaveBeenCalledTimes(1);
    expect(policy.mock.calls[0]?.[0]).toEqual({
      sessionId: "sess-xyz",
      request: makeRequest(),
    });
  });

  it("never throws when policy throws; returns reject with the error message instead", async () => {
    const handler = createPermissionBridge(() => {
      throw new Error("policy boom");
    });
    const result = await handler(makeRequest(), { sessionId: "sess-1" });
    expect(result).toEqual({ kind: "reject", feedback: expect.stringContaining("policy boom") });
  });

  it("never returns undefined: a policy returning undefined yields fail-closed reject", async () => {
    const handler = createPermissionBridge(() => undefined);
    const result = await handler(makeRequest(), { sessionId: "sess-1" });
    expect(result).toEqual({ kind: "reject", feedback: REJECT_ALL_FEEDBACK });
  });
});
