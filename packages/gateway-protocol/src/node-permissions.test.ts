import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
  NODE_PERMISSION_STATES,
  readNodePermissionDetails,
  readNodePermissionRequest,
} from "./node-permissions.js";
import { NodeInvokeResultParamsSchema } from "./schema/nodes.js";

describe("native node permission errors", () => {
  const validate = Compile(NodeInvokeResultParamsSchema);
  const base = { id: "invoke-1", nodeId: "mac-1", ok: false };

  it.each(NODE_PERMISSION_STATES)("preserves %s through the result contract", (state) => {
    const details = { capabilities: ["accessibility", "eventPosting", "screenRecording"], state };
    const result = {
      ...base,
      error: { code: "PERMISSION_MISSING", message: "Grant access", details },
    };
    expect(validate.Check(result)).toBe(true);
    expect(readNodePermissionDetails(result.error.details)).toEqual(details);
  });

  it("keeps results without permission details valid", () => {
    expect(validate.Check({ ...base, error: { code: "UNAVAILABLE", message: "Offline" } })).toBe(
      true,
    );
  });

  it("preserves the target identity in a permission request", () => {
    const request = {
      nodeId: "mac-1",
      nodeName: "Studio Mac",
      command: "screen.snapshot",
      capabilities: ["screenRecording"],
      state: "restart-required",
    };
    expect(readNodePermissionRequest(request)).toEqual(request);
    expect(readNodePermissionRequest({ ...request, nodeId: "" })).toBeUndefined();
    expect(readNodePermissionRequest({ ...request, command: 2 })).toBeUndefined();
    expect(readNodePermissionRequest({ ...request, nodeName: "" })).toBeUndefined();
  });

  it.each([
    { capabilities: [], state: "denied" },
    { capabilities: ["camera", "camera"], state: "denied" },
    { capabilities: [""], state: "denied" },
    { capabilities: ["camera"], state: "granted" },
  ])("rejects malformed permission details %j", (details) => {
    expect(validate.Check({ ...base, error: { code: "PERMISSION_MISSING", details } })).toBe(false);
    expect(readNodePermissionDetails(details)).toBeUndefined();
  });
});
