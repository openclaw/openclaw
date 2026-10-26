import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
const attachment = { environmentId: environment.id };
const backgroundStart = { action: "exec", argv: ["node", "server.mjs"], background: true };
type ToolResult = Awaited<ReturnType<NonNullable<ReturnType<typeof createCrabboxTool>>["execute"]>>;
function expectText(result: ToolResult, text: string) {
  expect(result.content).toEqual([{ type: "text", text }]);
}
function unexpected(): never {
  throw new Error("Unexpected Gateway operation");
}

function fixture(toolContext = context) {
  const request = vi.fn().mockImplementation(async (method: string) =>
    method === "environments.session.status"
      ? { attachment: null }
      : method === "environments.session.exec"
        ? commandResult
        : {
            attachment,
            environment: { id: environment.id, status: "available", worker: { state: "ready" } },
            reused: false,
          },
  );
  const tool = createCrabboxTool({
    context: toolContext,
    gateway: {
      isAvailable: async () => true,
      request,
      subscribeSessionChanges: unexpected,
      readSessionFacts: unexpected,
      withSessionFacts: unexpected,
      appendAgentMessage: unexpected,
      openPluginPanel: unexpected,
    },
  });
  return { request, tool };
}

describe("Crabbox conversation tool", () => {
  let tool: NonNullable<ReturnType<typeof createCrabboxTool>>;
  let request: ReturnType<typeof fixture>["request"];
  beforeEach(() => {
    const instance = fixture();
    tool = instance.tool!;
    request = instance.request;
  });
  const execute = (action: string, params: Record<string, unknown> = {}) =>
    tool.execute(action, { action, ...params });
  async function reply(action: string, response: unknown, text: string) {
    request.mockResolvedValueOnce(response);
    const result = await execute(action);
    expectText(result, text);
    expect(result.details).toBe(response);
  }

  it("explains an empty attachment without turning it into an error", async () => {
    await reply(
      "status",
      { attachment: null },
      "No Crabbox is attached to this conversation. Use action=create to create one.",
    );
  });

  it("lists usable profile choices while retaining machine catalog metadata", async () => {
    const profile = {
      id: "desktop",
      providerId: "crabbox",
      machines: [{ id: "small", label: "Small", os: "linux", cpu: 2 }],
      operatingSystems: [{ id: "linux" }, { id: "macos", disabledReason: "No host available" }],
    };
    request.mockResolvedValueOnce({ profiles: [profile, { id: "other", providerId: "other" }] });
    const result = await execute("profiles");
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining(
        "- desktop: desktop enabled; linux; macos (unavailable: No host available); small (linux)",
      ),
    });
    expect(result.details).toEqual({ profiles: [{ ...profile, desktop: true }] });
    request.mockResolvedValueOnce({ profiles: [] });
    expectText(await execute("profiles"), "No Crabbox profiles are currently available.");
  });

  it.each<[string | undefined, string | undefined, string]>([
    [undefined, undefined, "No Crabbox is attached to this conversation. Nothing to stop."],
    [
      "stopping",
      undefined,
      "Crabbox environment-one is detached from this conversation.\nEnvironment: stopping (destroying).",
    ],
    [
      "error",
      "Cleanup will retry",
      "Crabbox environment-one is detached from this conversation.\nEnvironment: error (destroying).\nCleanup will retry",
    ],
  ])("does not claim lease release before confirmed cleanup (%s)", async (status, error, text) => {
    const stopped = status
      ? { ...environment, status, worker: { state: "destroying", ...(error ? { error } : {}) } }
      : undefined;
    await reply("stop", { stopped: true, ...(stopped ? { environment: stopped } : {}) }, text);
  });

  it.each([false, true])("distinguishes a new attachment from reuse (%s)", async (reused) => {
    const response = { attachment, environment, reused };
    request.mockResolvedValueOnce({ attachment: null });
    await reply(
      "create",
      response,
      (reused ? "Reusing" : "Created") +
        " Crabbox environment-one.\nEnvironment: available (ready).",
    );
  });

  it.each([
    [
      false,
      "bootstrapping",
      "starting",
      "Crabbox environment-one is attached to this conversation.",
    ],
    [
      true,
      "destroyed",
      "unavailable",
      "Crabbox environment-one is no longer attached. Use action=create to create one.",
    ],
  ] as const)(
    "reports attachment and machine state independently (%s/%s)",
    async (closed, state, status, summary) => {
      const response = {
        attachment,
        closed,
        environment: { ...environment, status, worker: { ...environment.worker, state } },
      };
      await reply("status", response, summary + "\nEnvironment: " + status + " (" + state + ").");
    },
  );

  it.each([
    { code: 0, termination: "exit", signal: null, killed: false },
    { code: 7, termination: "exit", signal: null, killed: false },
    { code: null, termination: "timeout", signal: "SIGTERM", killed: true },
  ])("preserves command output and exit facts ($code/$termination)", async (outcome) => {
    const response = {
      ...commandResult,
      ...outcome,
      stdoutTruncatedBytes: 12,
      stderrTruncatedBytes: 3,
      outputLimitExceeded: true,
    };
    request.mockResolvedValueOnce(response);
    const result = await execute("exec", { argv: ["example"] });
    expectText(
      result,
      `${outcome.code === 0 ? "Command completed." : "Command failed."}
exit code: ${outcome.code}; termination: ${outcome.termination}; signal: ${outcome.signal}; killed: ${outcome.killed}
Environment: environment-one; workspace: /workspace
stdout truncated: 12 bytes
stderr truncated: 3 bytes
Output limit exceeded.

stdout:
  output

stderr:
warning
`,
    );
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
      const response = { ...commandResult, code, process: { processId: "app-one", state } };
      request.mockResolvedValueOnce(response);
      const result = await execute(action, {
        argv: ["server"],
        background: true,
        processId: "app-one",
      });
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining(
          "Process app-one: " +
            state +
            "." +
            (state === "running" ? " App readiness has not been checked." : ""),
        ),
      });
      expect(result.details).toBe(response);
    },
  );

  it("emits one public request update before create I/O without invented stages", async () => {
    const onUpdate = vi.fn();
    request.mockImplementation(async () => {
      expect(onUpdate).toHaveBeenCalledTimes(1);
      return { attachment, environment, reused: false };
    });
    await tool!.execute("create", { action: "create" }, undefined, onUpdate);
    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({
      progress: {
        text: "Requesting a Crabbox for this conversation (create or reuse)…",
        visibility: "channel",
        privacy: "public",
      },
    });
  });

  it("keeps progress failures out of execution and preserves Gateway failures", async () => {
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

  it("dedupes repeated calls until an empty attachment is replaced, across tool instances", async () => {
    const first = fixture();
    const retry = fixture();
    const next = fixture();
    for (const item of [first, retry]) {
      item.request.mockResolvedValueOnce({ attachment: null });
    }
    next.request.mockResolvedValueOnce({
      attachment: { environmentId: "newly-stopped-environment" },
    });
    await Promise.all(
      [first, retry, next].map((item) => item.tool!.execute("crabbox_0", { action: "create" })),
    );
    const keys = [first, retry, next].map(
      (item) =>
        item.request.mock.calls.find(([method]) => method === "environments.session.create")?.[1]
          .idempotencyKey,
    );
    expect(keys[0]).toEqual(expect.any(String));
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("reuses allocation identity on a replay without accepting caller-supplied ownership", async () => {
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
    const live = fixture({ ...context, getRuntimeConfig: () => current });
    current = {
      cloudWorkers: {
        profiles: {
          desktop: { provider: "crabbox" },
          web: { provider: "crabbox" },
        },
      },
    };
    await expect(live.tool!.execute("call-one", { action: "create" })).rejects.toThrow(
      "Choose a configured Crabbox profile",
    );
    current = {};
    await expect(
      live.tool!.execute("call-two", { action: "create", profileId: "desktop" }),
    ).rejects.toThrow("Choose a configured Crabbox profile");
    expect(live.request).not.toHaveBeenCalled();
  });

  it("preserves remote command argument and standard-input bytes", async () => {
    const argv = ["node", "-e", "process.stdout.write(process.argv[1])", "  padded\n"];
    const params = {
      environmentId: "environment-one",
      argv,
      input: "\n payload \n",
    };
    await execute("exec", params);
    expect(request).toHaveBeenCalledWith(
      "environments.session.exec",
      { action: "run", ...params },
      expect.anything(),
    );
  });

  it("gives replayed background starts the same process identity and stops only the selected process", async () => {
    await tool!.execute("launch", backgroundStart);
    const first = request.mock.calls[0]?.[1];
    await tool!.execute("launch", backgroundStart);
    expect(request.mock.calls[1]?.[1]).toEqual(first);
    expect(first).toMatchObject({
      action: "start",
      processId: expect.stringMatching(/^app-[a-f0-9]{64}$/u),
    });
    await tool!.execute("stop", { action: "process_stop", processId: first.processId });
    expect(request).toHaveBeenLastCalledWith(
      "environments.session.exec",
      { action: "stop", processId: first.processId },
      expect.anything(),
    );
  });

  it("retains the process identity for reconciliation after a lost launch acknowledgement", async () => {
    request.mockRejectedValueOnce(new Error("Gateway response timed out"));
    const execution = tool!.execute("launch", backgroundStart);
    const processId = request.mock.calls[0]?.[1].processId;
    await expect(execution).rejects.toThrow(
      `Background processId: ${processId}. Check process_status`,
    );
  });
});
