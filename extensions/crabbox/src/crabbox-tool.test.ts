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
  id: "box",
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
const presentation = (action: string, response: unknown, ...text: string[]) => ({
  action,
  response,
  text,
});
const state = (status: string, worker: string, error?: string) => ({
  ...environment,
  status,
  worker: { state: worker, ...(error ? { error } : {}) },
});
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

  it("lists profiles with machine metadata", async () => {
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

  it.each([
    presentation("status", { attachment: null }, "No Crabbox is attached", "Use action=create"),
    presentation("stop", { stopped: true }, "No Crabbox is attached", "Nothing to stop"),
    presentation(
      "stop",
      { stopped: true, environment: state("error", "destroying", "Cleanup will retry") },
      "is detached",
      "Environment: error (destroying).",
      "Cleanup will retry",
    ),
    ...[false, true].map((reused) =>
      presentation(
        "create",
        { attachment, environment, reused },
        `${reused ? "Reusing" : "Created"} Crabbox box.`,
        "Environment: available (ready).",
      ),
    ),
    presentation(
      "status",
      { attachment, closed: false, environment: state("starting", "bootstrapping") },
      "is attached to this conversation",
      "Environment: starting (bootstrapping).",
    ),
    presentation(
      "status",
      { attachment, closed: true, environment: state("unavailable", "destroyed") },
      "is no longer attached. Use action=create",
      "Environment: unavailable (destroyed).",
    ),
    ...[
      [0, "exit", null, false],
      [null, "timeout", "SIGTERM", true],
    ].map(([code, termination, signal, killed]) =>
      presentation(
        "exec",
        {
          ...commandResult,
          code,
          termination,
          signal,
          killed,
          stdoutTruncatedBytes: 12,
          stderrTruncatedBytes: 3,
          outputLimitExceeded: true,
        },
        code === 0 ? "Command completed." : "Command failed.",
        `exit code: ${code}; termination: ${termination}; signal: ${signal}; killed: ${killed}`,
        "Environment: box; workspace: /workspace",
        "stdout truncated: 12 bytes",
        "stderr truncated: 3 bytes",
        "Output limit exceeded.",
        "stdout:\n  output\n\nstderr:\nwarning\n",
      ),
    ),
    ...["process_status", "process_stop"].map((action) => {
      const processState = action === "process_stop" ? "exited" : "running";
      return presentation(
        action,
        { ...commandResult, process: { processId: "app-one", state: processState } },
        `Process app-one: ${processState}.` +
          (processState === "running" ? " App readiness has not been checked." : ""),
      );
    }),
  ])("presents $action: $text", async ({ action, response, text }) => {
    if (action === "create") {
      request.mockResolvedValueOnce({ attachment: null });
    }
    request.mockResolvedValueOnce(response);
    const result = await execute(action, { argv: ["example"], processId: "app-one" });
    for (const fragment of text) {
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining(fragment) });
    }
    if (action === "stop") {
      expect(result.content[0]).toMatchObject({ text: expect.not.stringContaining("released") });
    }
    expect(result.details).toBe(response);
  });

  it("publishes one update before create I/O", async () => {
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

  it("ignores progress failure but preserves Gateway failure", async () => {
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

  it("rejects invalid or aborted input before effects", async () => {
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
  ])("requires a permitted conversation and provider", (toolContext) => {
    expect(fixture(toolContext).tool).toBeNull();
  });

  it("dedupes across instances until the attachment changes", async () => {
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

  it("replays allocation identity without trusting caller ownership", async () => {
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

  it("requires a profile choice and rechecks runtime config", async () => {
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

  it("preserves command and stdin bytes", async () => {
    const argv = ["node", "-e", "process.stdout.write(process.argv[1])", "  padded\n"];
    const params = {
      environmentId: "box",
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

  it("replays background identity and stops only that process", async () => {
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

  it("retains process identity after a lost launch acknowledgement", async () => {
    request.mockRejectedValueOnce(new Error("Gateway response timed out"));
    const execution = tool!.execute("launch", backgroundStart);
    const processId = request.mock.calls[0]?.[1].processId;
    await expect(execution).rejects.toThrow(
      `Background processId: ${processId}. Check process_status`,
    );
  });
});
