import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { resolvePermissionRequest } from "./client.js";

function makePermissionRequest(
  overrides: Partial<RequestPermissionRequest> = {},
): RequestPermissionRequest {
  const { toolCall: toolCallOverride, options: optionsOverride, ...restOverrides } = overrides;
  const base: RequestPermissionRequest = {
    sessionId: "session-1",
    toolCall: {
      toolCallId: "tool-1",
      title: "read: src/index.ts",
      status: "pending",
    },
    options: [
      { kind: "allow_once", name: "Allow once", optionId: "allow" },
      { kind: "reject_once", name: "Reject once", optionId: "reject" },
    ],
  };

  return {
    ...base,
    ...restOverrides,
    toolCall: toolCallOverride ? { ...base.toolCall, ...toolCallOverride } : base.toolCall,
    options: optionsOverride ?? base.options,
  };
}

describe("resolvePermissionRequest", () => {
  it("auto-approves safe tools without prompting", async () => {
    const prompt = vi.fn(async () => true);
    const res = await resolvePermissionRequest(makePermissionRequest(), { prompt, log: () => {} });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prompts for dangerous tool names inferred from title", async () => {
    const prompt = vi.fn(async () => true);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: { toolCallId: "tool-2", title: "exec: uname -a", status: "pending" },
      }),
      { prompt, log: () => {} },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith("exec", "exec: uname -a");
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it("uses allow_always and reject_always when once options are absent", async () => {
    const options: RequestPermissionRequest["options"] = [
      { kind: "allow_always", name: "Always allow", optionId: "allow-always" },
      { kind: "reject_always", name: "Always reject", optionId: "reject-always" },
    ];
    const prompt = vi.fn(async () => false);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: { toolCallId: "tool-3", title: "gateway: reload", status: "pending" },
        options,
      }),
      { prompt, log: () => {} },
    );
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "reject-always" } });
  });

  it("prompts when tool identity is unknown and can still approve", async () => {
    const prompt = vi.fn(async () => true);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: {
          toolCallId: "tool-4",
          title: "Modifying critical configuration file",
          status: "pending",
        },
      }),
      { prompt, log: () => {} },
    );
    expect(prompt).toHaveBeenCalledWith(undefined, "Modifying critical configuration file");
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it("returns cancelled when no permission options are present", async () => {
    const prompt = vi.fn(async () => true);
    const res = await resolvePermissionRequest(makePermissionRequest({ options: [] }), {
      prompt,
      log: () => {},
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
  });
});
