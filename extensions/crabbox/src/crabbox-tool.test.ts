import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createCrabboxTool } from "./crabbox-tool.js";

const context: OpenClawPluginToolContext = {
  sessionId: "session-one",
  sessionKey: "agent:main:preview",
  config: {
    cloudWorkers: {
      profiles: { desktop: { provider: "crabbox", settings: { desktop: true } } },
    },
  },
};

function fixture(toolContext = context) {
  const request = vi.fn().mockResolvedValue({ environmentId: "environment-one" });
  const tool = createCrabboxTool({
    context: toolContext,
    gateway: { isAvailable: async () => true, request },
  });
  return { request, tool };
}

describe("Crabbox conversation tool", () => {
  it.each([
    { ...context, sandboxed: true },
    { ...context, sessionId: undefined },
    { ...context, config: {} },
    { ...context, config: { cloudWorkers: { profiles: { other: { provider: "other" } } } } },
  ])("is absent without a permitted conversation and configured provider", (toolContext) => {
    expect(fixture(toolContext).tool).toBeNull();
  });

  it("reuses allocation identity on a replay without accepting caller-supplied ownership", async () => {
    const { tool, request } = fixture();
    const params = {
      action: "create",
      presentation: "desktop",
      sessionId: "other-session",
      idempotencyKey: "forged",
    };
    await tool!.execute("call-one", params);
    await tool!.execute("call-one", params);
    expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
    expect(request.mock.calls[0]?.[1]).toEqual({
      profileId: "desktop",
      presentation: "desktop",
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const second = fixture({ ...context, sessionId: "session-two" });
    await second.tool!.execute("call-one", params);
    expect(second.request.mock.calls[0]?.[1].idempotencyKey).not.toBe(
      request.mock.calls[0]?.[1].idempotencyKey,
    );
  });

  it("requires a profile choice when more than one is configured and rechecks runtime config", async () => {
    let current = context.config;
    const { tool, request } = fixture({ ...context, getRuntimeConfig: () => current });
    current = {
      cloudWorkers: {
        profiles: {
          desktop: { provider: "crabbox" },
          web: { provider: "crabbox" },
        },
      },
    };
    await expect(tool!.execute("call-one", { action: "create" })).rejects.toThrow(
      "Choose a configured Crabbox profile",
    );
    current = {};
    await expect(
      tool!.execute("call-two", { action: "create", profileId: "desktop" }),
    ).rejects.toThrow("Choose a configured Crabbox profile");
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves remote command argument and standard-input bytes", async () => {
    const { tool, request } = fixture();
    const argv = ["node", "-e", "process.stdout.write(process.argv[1])", "  padded\n"];
    await tool!.execute("call-one", {
      action: "exec",
      environmentId: "environment-one",
      argv,
      input: "\n payload \n",
    });
    expect(request).toHaveBeenCalledWith(
      "environments.session.exec",
      {
        action: "run",
        environmentId: "environment-one",
        argv,
        input: "\n payload \n",
      },
      expect.anything(),
    );
  });

  it("gives replayed background starts the same process identity and stops only the selected process", async () => {
    const { tool, request } = fixture();
    await tool!.execute("launch", {
      action: "exec",
      argv: ["node", "server.mjs"],
      background: true,
    });
    const first = request.mock.calls[0]?.[1];
    await tool!.execute("launch", {
      action: "exec",
      argv: ["node", "server.mjs"],
      background: true,
    });
    expect(request.mock.calls[1]?.[1]).toEqual(first);
    expect(first).toMatchObject({
      action: "start",
      processId: expect.stringMatching(/^app-[a-f0-9]{64}$/u),
    });
    await tool!.execute("stop", { action: "process_stop", processId: first.processId });
    expect(request).toHaveBeenLastCalledWith(
      "environments.session.exec",
      {
        action: "stop",
        processId: first.processId,
      },
      expect.anything(),
    );
  });

  it("retains the process identity for reconciliation after a lost launch acknowledgement", async () => {
    const { tool, request } = fixture();
    request.mockRejectedValueOnce(new Error("Gateway response timed out"));
    const execution = tool!.execute("launch", {
      action: "exec",
      argv: ["node", "server.mjs"],
      background: true,
    });
    const processId = request.mock.calls[0]?.[1].processId;
    await expect(execution).rejects.toThrow(
      `Background processId: ${processId}. Check process_status`,
    );
  });
});
