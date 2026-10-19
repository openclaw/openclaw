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

const environment = {
  id: "environment-one",
  status: "available",
  worker: { profileId: "desktop", state: "ready" },
};
const commandResult = {
  environmentId: environment.id,
  workspaceDir: "/workspace",
  stdout: "  output\n",
  stderr: "warning\n",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
};

function fixture(toolContext = context) {
  const request = vi.fn().mockImplementation(async (method: string) =>
    method === "environments.session.status"
      ? { attachment: null }
      : method === "environments.session.exec"
        ? commandResult
        : {
            attachment: { environmentId: "environment-one" },
            environment: { id: "environment-one", status: "available", worker: { state: "ready" } },
            reused: false,
          },
  );
  const tool = createCrabboxTool({
    context: toolContext,
    gateway: {
      isAvailable: async () => true,
      request,
      subscribeSessionChanges() {
        throw new Error("Unexpected session change subscription");
      },
      async readSessionFacts() {
        throw new Error("Unexpected session facts request");
      },
      async withSessionFacts() {
        throw new Error("Unexpected session read scope");
      },
      async openPluginPanel() {
        throw new Error("Unexpected plugin panel request");
      },
    },
  });
  return { request, tool };
}

describe("Crabbox conversation tool", () => {
  it("explains an empty attachment without turning it into an error", async () => {
    const { tool } = fixture();
    const result = await tool!.execute("status", { action: "status" });
    expect(result.content).toEqual([
      {
        type: "text",
        text: "No Crabbox is attached to this conversation. Use action=create to create one.",
      },
    ]);
    expect(result.details).toEqual({ attachment: null });
  });

  it("lists usable profile choices while retaining machine catalog metadata", async () => {
    const { tool, request } = fixture();
    const profile = {
      id: "desktop",
      providerId: "crabbox",
      machines: [{ id: "small", label: "Small", os: "linux", cpu: 2 }],
      operatingSystems: [{ id: "linux" }, { id: "macos", disabledReason: "No host available" }],
    };
    request.mockResolvedValueOnce({ profiles: [profile, { id: "other", providerId: "other" }] });
    const result = await tool!.execute("profiles", { action: "profiles" });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining(
        "- desktop: desktop enabled; linux; macos (unavailable: No host available); small (linux)",
      ),
    });
    expect(result.details).toEqual({ profiles: [{ ...profile, desktop: true }] });
    request.mockResolvedValueOnce({ profiles: [] });
    expect((await tool!.execute("profiles", { action: "profiles" })).content).toEqual([
      { type: "text", text: "No Crabbox profiles are currently available." },
    ]);
  });

  it.each([
    {
      response: { stopped: true },
      text: "No Crabbox is attached to this conversation. Nothing to stop.",
    },
    {
      response: {
        stopped: true,
        environment: { ...environment, status: "stopping", worker: { state: "destroying" } },
      },
      text: "Crabbox environment-one is detached from this conversation.\nEnvironment: stopping (destroying).",
    },
    {
      response: {
        stopped: true,
        environment: {
          ...environment,
          status: "error",
          worker: { state: "destroying", error: "Cleanup will retry" },
        },
      },
      text: "Crabbox environment-one is detached from this conversation.\nEnvironment: error (destroying).\nCleanup will retry",
    },
  ])(
    "does not claim lease release before confirmed cleanup ($text)",
    async ({ response, text }) => {
      const { tool, request } = fixture();
      request.mockResolvedValueOnce(response);
      const result = await tool!.execute("stop", { action: "stop" });
      expect(result.content).toEqual([{ type: "text", text }]);
      expect(result.details).toBe(response);
    },
  );

  it.each([false, true])("distinguishes a new attachment from reuse (%s)", async (reused) => {
    const { tool, request } = fixture();
    const response = { attachment: { environmentId: environment.id }, environment, reused };
    request.mockResolvedValueOnce({ attachment: null }).mockResolvedValueOnce(response);
    const result = await tool!.execute("create", { action: "create" });
    expect(result.content).toEqual([
      {
        type: "text",
        text:
          (reused ? "Reusing" : "Created") +
          " Crabbox environment-one.\nEnvironment: available (ready).",
      },
    ]);
    expect(result.details).toBe(response);
  });

  it.each([
    {
      closed: false,
      state: "bootstrapping",
      status: "starting",
      summary: "Crabbox environment-one is attached to this conversation.",
    },
    {
      closed: true,
      state: "destroyed",
      status: "unavailable",
      summary: "Crabbox environment-one is no longer attached. Use action=create to create one.",
    },
  ])(
    "reports attachment and machine state independently ($state)",
    async ({ closed, state, status, summary }) => {
      const { tool, request } = fixture();
      const response = {
        attachment: { environmentId: environment.id },
        closed,
        environment: { ...environment, status, worker: { ...environment.worker, state } },
      };
      request.mockResolvedValueOnce(response);
      const result = await tool!.execute("status", { action: "status" });
      expect(result.content).toEqual([
        { type: "text", text: summary + "\nEnvironment: " + status + " (" + state + ")." },
      ]);
      expect(result.details).toBe(response);
    },
  );

  it.each([
    { code: 0, termination: "exit", signal: null, killed: false },
    { code: 7, termination: "exit", signal: null, killed: false },
    { code: null, termination: "timeout", signal: "SIGTERM", killed: true },
  ])("preserves command output and exit facts ($code/$termination)", async (outcome) => {
    const { tool, request } = fixture();
    const response = {
      ...commandResult,
      ...outcome,
      stdoutTruncatedBytes: 12,
      stderrTruncatedBytes: 3,
      outputLimitExceeded: true,
    };
    request.mockResolvedValueOnce(response);
    const result = await tool!.execute("run", { action: "exec", argv: ["example"] });
    const content = result.content[0];
    if (content?.type !== "text") {
      throw new Error("Expected readable feedback");
    }
    expect(content.text).toContain(outcome.code === 0 ? "Command completed" : "Command failed");
    expect(content.text).toContain("exit code: " + outcome.code);
    expect(content.text).toContain("termination: " + outcome.termination);
    expect(content.text).toContain("signal: " + outcome.signal);
    expect(content.text).toContain("killed: " + outcome.killed);
    expect(content.text).toContain("stdout:\n  output\n");
    expect(content.text).toContain("stderr:\nwarning\n");
    expect(content.text).toContain("stdout truncated: 12 bytes");
    expect(content.text).toContain("stderr truncated: 3 bytes");
    expect(content.text).toContain("Output limit exceeded");
    expect(result.details).toBe(response);
  });

  it.each([
    { action: "exec", state: "running", code: 0 },
    { action: "exec", state: "exited", code: 1 },
    { action: "process_status", state: "running", code: null },
    { action: "process_stop", state: "exited", code: null },
  ])(
    "reports observed process state, not app readiness ($action/$state)",
    async ({ action, state, code }) => {
      const { tool, request } = fixture();
      const response = { ...commandResult, code, process: { processId: "app-one", state } };
      request.mockResolvedValueOnce(response);
      const result = await tool!.execute("process", {
        action,
        argv: ["server"],
        background: true,
        processId: "app-one",
      });
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining("Process app-one: " + state + "."),
      });
      if (state === "running") {
        expect(result.content[0]).toMatchObject({
          text: expect.stringContaining("App readiness has not been checked."),
        });
      }
      expect(result.details).toBe(response);
    },
  );

  it("emits one public request update before create I/O without invented stages", async () => {
    const { tool, request } = fixture();
    const onUpdate = vi.fn();
    request.mockImplementation(async () => {
      expect(onUpdate).toHaveBeenCalledTimes(1);
      return { attachment: { environmentId: environment.id }, environment, reused: false };
    });
    await tool!.execute("create", { action: "create" }, undefined, onUpdate);
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        progress: {
          text: "Requesting a Crabbox for this conversation (create or reuse)…",
          visibility: "channel",
          privacy: "public",
        },
      }),
    );
  });

  it("keeps progress failures out of execution and preserves Gateway failures", async () => {
    const { tool, request } = fixture();
    const onUpdate = vi.fn(() => {
      throw new Error("Progress display unavailable");
    });
    request.mockResolvedValueOnce(commandResult);
    expect(
      (await tool!.execute("run", { action: "exec", argv: ["example"] }, undefined, onUpdate))
        .details,
    ).toBe(commandResult);
    request.mockRejectedValueOnce(new Error("Gateway response timed out"));
    await expect(
      tool!.execute("run", { action: "exec", argv: ["example"] }, undefined, onUpdate),
    ).rejects.toThrow("Gateway response timed out");
  });

  it("does not emit progress or dispatch on invalid or aborted input", async () => {
    const { tool, request } = fixture();
    const onUpdate = vi.fn();
    await expect(
      tool!.execute("invalid", { action: "exec", argv: [] }, undefined, onUpdate),
    ).rejects.toThrow("argv");
    await expect(
      tool!.execute("aborted", { action: "create" }, AbortSignal.abort(), onUpdate),
    ).rejects.toThrow();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { ...context, sandboxed: true },
    { ...context, sessionId: undefined },
    { ...context, config: { cloudWorkers: { profiles: { other: { provider: "other" } } } } },
  ])("is absent without a permitted conversation and configured provider", (toolContext) => {
    expect(fixture(toolContext).tool).toBeNull();
  });

  it.each([null])(
    "dedupes repeated calls until attachment %s is replaced, across tool instances",
    async (previousEnvironmentId) => {
      const first = fixture();
      const retry = fixture();
      const next = fixture();
      for (const item of [first, retry]) {
        item.request.mockResolvedValueOnce({
          attachment: previousEnvironmentId ? { environmentId: previousEnvironmentId } : null,
        });
      }
      next.request.mockResolvedValueOnce({
        attachment: { environmentId: "newly-stopped-environment" },
      });
      await Promise.all(
        [first, retry, next].map(({ tool }) => tool!.execute("crabbox_0", { action: "create" })),
      );
      const keys = [first, retry, next].map(
        ({ request }) =>
          request.mock.calls.find(([method]) => method === "environments.session.create")?.[1]
            .idempotencyKey,
      );
      expect(keys[0]).toEqual(expect.any(String));
      expect(keys[1]).toBe(keys[0]);
      expect(keys[2]).not.toBe(keys[0]);
    },
  );

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
    expect(request.mock.calls[1]).toEqual(request.mock.calls[3]);
    expect(request.mock.calls[1]?.[1]).toEqual({
      profileId: "desktop",
      presentation: "desktop",
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const second = fixture({ ...context, sessionId: "session-two" });
    await second.tool!.execute("call-one", params);
    expect(second.request.mock.calls[1]?.[1].idempotencyKey).not.toBe(
      request.mock.calls[1]?.[1].idempotencyKey,
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
