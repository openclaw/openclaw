import { describe, expect, it } from "vitest";
import { runAcpRuntimeAdapterContract } from "../../../src/acp/runtime/adapter-contract.testkit.js";
import { AcpRuntimeError } from "../../../src/acp/runtime/errors.js";
import { resolveCodexSdkPluginConfig, type ResolvedCodexSdkPluginConfig } from "./config.js";
import { CodexSdkRuntime } from "./runtime.js";

type FakeThreadEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "item.completed"; item: { id: string; type: "agent_message"; text: string } }
  | {
      type: "item.completed";
      item: { id: string; type: "command_execution"; command: string; status: string };
    }
  | {
      type: "turn.completed";
      usage: {
        input_tokens: number;
        cached_input_tokens: number;
        output_tokens: number;
        reasoning_output_tokens: number;
      };
    };

class FakeThread {
  id: string | null;
  readonly events: FakeThreadEvent[];
  readonly inputs: unknown[] = [];

  constructor(id: string | null, events: FakeThreadEvent[]) {
    this.id = id;
    this.events = events;
  }

  async runStreamed(input: unknown): Promise<{ events: AsyncGenerator<FakeThreadEvent> }> {
    this.inputs.push(input);
    const self = this;
    return {
      events: (async function* () {
        for (const event of self.events) {
          if (event.type === "thread.started") {
            self.id = event.thread_id;
          }
          yield event;
        }
      })(),
    };
  }
}

class FakeCodex {
  readonly constructorOptions: unknown[] = [];
  readonly startedThreads: FakeThread[] = [];
  readonly resumedThreads: Array<{ id: string; thread: FakeThread }> = [];
  readonly startOptions: unknown[] = [];
  readonly resumeOptions: Array<{ id: string; options: unknown }> = [];

  startThread(options?: unknown): FakeThread {
    this.startOptions.push(options);
    const thread = new FakeThread(null, [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "cmd-1", type: "command_execution", command: "pnpm test", status: "completed" },
      },
      {
        type: "item.completed",
        item: { id: "msg-1", type: "agent_message", text: "done" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 2,
          output_tokens: 3,
          reasoning_output_tokens: 4,
        },
      },
    ]);
    this.startedThreads.push(thread);
    return thread;
  }

  resumeThread(id: string, options?: unknown): FakeThread {
    this.resumeOptions.push({ id, options });
    const thread = new FakeThread(id, [
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "msg-2", type: "agent_message", text: `resumed:${id}` },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      },
    ]);
    this.resumedThreads.push({ id, thread });
    return thread;
  }
}

function createConfig(
  overrides: Partial<ResolvedCodexSdkPluginConfig> = {},
): ResolvedCodexSdkPluginConfig {
  return {
    ...resolveCodexSdkPluginConfig({ workspaceDir: "/tmp/workspace" }),
    skipGitRepoCheck: true,
    ...overrides,
  };
}

function createRuntime(
  fake = new FakeCodex(),
  configOverrides: Partial<ResolvedCodexSdkPluginConfig> = {},
) {
  return {
    fake,
    runtime: new CodexSdkRuntime({
      config: createConfig(configOverrides),
      loadSdk: async () => ({
        Codex: class extends FakeCodex {
          constructor(options?: unknown) {
            super();
            fake.constructorOptions.push(options);
            return fake;
          }
        } as never,
      }),
    }),
  };
}

describe("CodexSdkRuntime", () => {
  it("passes the shared ACP adapter contract suite", async () => {
    await runAcpRuntimeAdapterContract({
      createRuntime: async () => createRuntime().runtime,
      agentId: "codex",
      successPrompt: "contract-pass",
      includeControlChecks: false,
      assertSuccessEvents: (events) => {
        expect(events.some((event) => event.type === "text_delta" && event.text === "done")).toBe(
          true,
        );
        expect(events.some((event) => event.type === "done")).toBe(true);
      },
    });
  });

  it("maps Codex SDK streamed items into ACP events and status identifiers", async () => {
    const { runtime } = createRuntime();
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:123",
      agent: "codex",
      mode: "persistent",
    });

    const events = [];
    for await (const event of runtime.runTurn({
      handle,
      text: "hello",
      mode: "prompt",
      requestId: "req-1",
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "status",
      text: "Codex thread started: thread-1",
      tag: "session_info_update",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_call", title: "pnpm test" }),
        expect.objectContaining({ type: "text_delta", text: "done" }),
        expect.objectContaining({ type: "status", tag: "usage_update", used: 10 }),
        expect.objectContaining({ type: "done" }),
      ]),
    );

    const status = await runtime.getStatus({ handle });
    expect(status.agentSessionId).toBe("thread-1");
    expect(status.backendSessionId).toBe("thread-1");
  });

  it("writes image attachments to local SDK image inputs", async () => {
    const fake = new FakeCodex();
    const { runtime } = createRuntime(fake);
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:image",
      agent: "codex",
      mode: "persistent",
    });

    for await (const _event of runtime.runTurn({
      handle,
      text: "describe",
      mode: "prompt",
      requestId: "req-image",
      attachments: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
    })) {
      // consume stream
    }

    const input = fake.startedThreads[0]?.inputs[0];
    expect(input).toEqual([
      {
        type: "text",
        text: expect.stringContaining("describe"),
      },
      expect.objectContaining({
        type: "local_image",
        path: expect.stringContaining("image-1.png"),
      }),
    ]);
  });

  it("resumes the SDK thread after runtime config option changes", async () => {
    const fake = new FakeCodex();
    const { runtime } = createRuntime(fake);
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:config",
      agent: "codex",
      mode: "persistent",
    });
    for await (const _event of runtime.runTurn({
      handle,
      text: "first",
      mode: "prompt",
      requestId: "req-first",
    })) {
      // consume stream
    }

    await runtime.setConfigOption?.({ handle, key: "model", value: "gpt-5.4" });

    expect(fake.resumedThreads[0]?.id).toBe("thread-1");
    expect(fake.resumeOptions[0]?.options).toEqual(expect.objectContaining({ model: "gpt-5.4" }));
  });

  it("uses route aliases for SDK options and route context", async () => {
    const fake = new FakeCodex();
    const { runtime } = createRuntime(fake);
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex-deep:acp:route",
      agent: "codex-deep",
      mode: "persistent",
    });

    expect(fake.startOptions[0]).toEqual(expect.objectContaining({ modelReasoningEffort: "high" }));

    for await (const _event of runtime.runTurn({
      handle,
      text: "inspect architecture",
      mode: "prompt",
      requestId: "req-route",
    })) {
      // consume stream
    }

    expect(fake.startedThreads[0]?.inputs[0]).toEqual(
      expect.stringContaining('<openclaw-codex-route route="codex/deep">'),
    );
  });

  it("injects the OpenClaw MCP backchannel into Codex SDK config", async () => {
    const fake = new FakeCodex();
    const { runtime } = createRuntime(fake, {
      config: {
        show_raw_agent_reasoning: true,
        mcp_servers: {
          existing: {
            command: "node",
            args: ["existing.mjs"],
          },
        },
      },
    });

    await runtime.probeAvailability();

    expect(fake.constructorOptions[0]).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          show_raw_agent_reasoning: true,
          mcp_servers: expect.objectContaining({
            existing: expect.objectContaining({ command: "node" }),
            "openclaw-codex": expect.objectContaining({
              command: process.execPath,
              args: [expect.stringContaining("backchannel-server.mjs")],
              default_tools_approval_mode: "approve",
              env: expect.objectContaining({
                OPENCLAW_CODEX_BACKCHANNEL_ALLOWED_METHODS:
                  expect.stringContaining("codex.proposal.create"),
                OPENCLAW_CODEX_BACKCHANNEL_REQUIRE_WRITE_TOKEN: "true",
              }),
            }),
          }),
        }),
      }),
    );
  });

  it("can switch a live session to another route", async () => {
    const fake = new FakeCodex();
    const { runtime } = createRuntime(fake);
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:switch-route",
      agent: "codex",
      mode: "persistent",
    });

    await runtime.setConfigOption?.({ handle, key: "route", value: "review" });

    expect(fake.startOptions[1]).toEqual(
      expect.objectContaining({
        modelReasoningEffort: "high",
        approvalPolicy: "on-request",
      }),
    );
    const status = await runtime.getStatus({ handle });
    expect(status.details?.route).toBe("codex/review");
  });

  it("rejects non-Codex agents by default", async () => {
    const { runtime } = createRuntime();

    await expect(
      runtime.ensureSession({
        sessionKey: "agent:claude:acp:123",
        agent: "claude",
        mode: "persistent",
      }),
    ).rejects.toBeInstanceOf(AcpRuntimeError);
  });
});
