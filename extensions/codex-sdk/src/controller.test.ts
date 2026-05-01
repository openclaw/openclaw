import { afterEach, describe, expect, it } from "vitest";
import { resolveCodexSdkPluginConfig } from "./config.js";
import { createCodexNativeController } from "./controller.js";
import { CodexSdkRuntime } from "./runtime.js";
import { FileCodexNativeStateStore } from "./state.js";
import { createTempDirTracker } from "./test-helpers.js";

const tempStateDirs = createTempDirTracker("openclaw-codex-sdk-controller-test-");
const createTempStateDir = () => tempStateDirs.create();

afterEach(tempStateDirs.cleanup);

class FakeThread {
  id: string | null = null;
  readonly inputs: unknown[] = [];

  async runStreamed(input: unknown) {
    this.inputs.push(input);
    const self = this;
    return {
      events: (async function* () {
        self.id = "thread-executed";
        yield { type: "thread.started" as const, thread_id: "thread-executed" };
        yield { type: "turn.started" as const };
        yield {
          type: "item.completed" as const,
          item: { id: "msg-1", type: "agent_message" as const, text: "proposal executed" },
        };
        yield { type: "turn.completed" as const };
      })(),
    };
  }
}

class FakeCodex {
  readonly thread = new FakeThread();

  startThread(): FakeThread {
    return this.thread;
  }

  resumeThread(): FakeThread {
    return this.thread;
  }
}

describe("CodexNativeController", () => {
  it("executes proposals through the SDK runtime and exports replay records", async () => {
    const stateDir = await createTempStateDir();
    const config = resolveCodexSdkPluginConfig({
      workspaceDir: "/tmp/workspace",
      rawConfig: {
        model: "gpt-5.5",
        modelReasoningEffort: "xhigh",
      },
    });
    const stateStore = new FileCodexNativeStateStore({ stateDir });
    const fakeCodex = new FakeCodex();
    const runtime = new CodexSdkRuntime({
      config,
      stateStore,
      loadSdk: async () => ({
        Codex: class extends FakeCodex {
          constructor() {
            super();
            return fakeCodex;
          }
        } as never,
      }),
    });
    const controller = createCodexNativeController({
      config,
      stateDir,
      stateStore,
      runtime,
    });
    expect(controller.listRoutes()).toContainEqual(
      expect.objectContaining({
        label: "codex/default",
        model: "gpt-5.5",
        modelReasoningEffort: "xhigh",
      }),
    );

    await stateStore.upsertSession({
      sessionKey: "source",
      backend: "codex-sdk",
      agent: "codex",
      routeId: "default",
      routeLabel: "codex/default",
      lifecycle: "started",
      status: "active",
    });
    await stateStore.recordEvent({
      sessionKey: "source",
      backend: "codex-sdk",
      routeId: "default",
      routeLabel: "codex/default",
      sdkEventType: "item.completed",
      mappedEvents: [
        {
          type: "text_delta",
          text: [
            "```openclaw-proposal",
            JSON.stringify({ title: "Wire Codex execute", actions: ["run proposal"] }),
            "```",
          ].join("\n"),
        },
      ],
    });
    const proposal = (await controller.listInbox())[0]!;

    const result = await controller.executeProposal(proposal.id, {
      route: "ship",
      sessionKey: "codex:proposal:test",
    });

    expect(result).toMatchObject({
      sessionKey: "codex:proposal:test",
      backendSessionId: "thread-executed",
      text: "proposal executed",
    });
    expect(String(fakeCodex.thread.inputs[0])).toContain("Wire Codex execute");
    expect(await stateStore.getProposal(proposal.id)).toMatchObject({
      executedSessionKey: "codex:proposal:test",
      executedThreadId: "thread-executed",
      executionRouteId: "ship",
    });

    const exported = await controller.exportSession("codex:proposal:test", {
      format: "markdown",
    });
    expect(exported.text).toContain("# Codex Session codex:proposal:test");
    expect(exported.text).toContain("proposal executed");
  });
});
