import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentHarnessCompactParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "../../harness.js";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import * as compactionRuntime from "./compact.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject } from "./protocol.js";
import { seedRunSessionOwnerForTest } from "./run-attempt-session-owners.test-support.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createCodexRuntimePlanFixture,
  createParams,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { setAgentWorkspaceForTest } from "./run-attempt-workspace.test-support.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";
import {
  createIsolatedCodexAppServerClient,
  readCodexAppServerClientProcessIdentity,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

const transport = vi.hoisted(() => ({
  phase: "turn" as "turn" | "compaction",
  requests: [] as Array<{
    requestKind: string;
    threadId: string;
    turnId: string;
    hasCompactionTrigger: boolean;
  }>,
}));

vi.unmock("node:child_process");
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    async fetchWithSsrFGuard(args: Parameters<typeof actual.fetchWithSsrFGuard>[0]) {
      expect(args.url).toBe("https://api.openai.com/v1/responses");
      const headers = new Headers(args.init?.headers);
      expect(headers.has("authorization")).toBe(false);
      const body: unknown = await new Response(args.init?.body).json();
      const metadata: unknown = JSON.parse(headers.get("x-codex-turn-metadata") ?? "{}");
      assert(isJsonObject(body) && isJsonObject(metadata));
      expect(body.model).toBe(MODEL);
      expect(metadata.request_kind).toBe(transport.phase);
      assert(
        typeof metadata.request_kind === "string" &&
          typeof metadata.thread_id === "string" &&
          typeof metadata.turn_id === "string",
      );
      assert(transport.requests.length < 2, "Unexpected additional native model request");
      const compaction = metadata.request_kind === "compaction";
      const hasCompactionTrigger =
        Array.isArray(body.input) &&
        body.input.some((item) => isJsonObject(item) && item.type === "compaction_trigger");
      expect(hasCompactionTrigger).toBe(compaction);
      args.beforeRequest?.();
      transport.requests.push({
        requestKind: metadata.request_kind,
        threadId: metadata.thread_id,
        turnId: metadata.turn_id,
        hasCompactionTrigger,
      });
      const id = `synthetic-compaction-${transport.requests.length}`;
      const item = compaction
        ? { type: "compaction", encrypted_content: "SYNTHETIC_NATIVE_COMPACTION" }
        : {
            type: "message",
            role: "assistant",
            id: "setup-answer",
            content: [{ type: "output_text", text: "COMPACT_READY" }],
          };
      const events = [
        { type: "response.created", response: { id } },
        { type: "response.output_item.done", item },
        {
          type: "response.completed",
          response: { id, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
        },
      ];
      return {
        response: new Response(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
        release: async () => {},
      };
    },
  };
});

setupRunAttemptTestHooks();

const MODEL = "gpt-5.6-luna";

// Core harness/model selection and shared-client pool selection remain fixture inputs.
// Native protocol, production host admission, source authority, and compaction are real.
it(
  "compacts with a fresh host source after the setup host closes",
  { timeout: 150_000 },
  async () => {
    const native = await createCodexNativeTestState(path.join(tempDir, "native"));
    const childEnv = Object.fromEntries(
      Object.entries(native.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    for (const [name, value] of Object.entries(native.env)) {
      if (name !== "PATH") {
        vi.stubEnv(name, value);
      }
    }
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "state"));
    await seedRunSessionOwnerForTest("session-1", "agent:main:session-1");
    transport.phase = "turn";
    transport.requests = [];
    const summary = {
      sourceHead: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
        encoding: "utf8",
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
        timeout: 5_000,
      }).trim(),
      nativeSha256: createHash("sha256")
        .update(await fs.readFile(native.command))
        .digest("hex"),
      nativeVersion: "",
      setupHostClosed: false,
      compacted: false,
      nativeExited: false,
      requests: transport.requests,
    };
    let client: Awaited<ReturnType<typeof createIsolatedCodexAppServerClient>> | undefined;
    let closeHost: (() => void) | undefined;
    try {
      await fs.writeFile(
        path.join(native.codexHome, "config.toml"),
        [
          `model="${MODEL}"`,
          'model_provider="compaction-fixture"',
          'cli_auth_credentials_store="ephemeral"',
          'web_search="disabled"',
          'approval_policy="never"',
          'sandbox_mode="read-only"',
          "allow_login_shell=false",
          "[features]",
          "shell_snapshot=false",
          "code_mode=false",
          "[analytics]",
          "enabled=false",
          "[feedback]",
          "enabled=false",
          "[model_providers.compaction-fixture]",
          // Native provider identity selects Responses V2 compaction.
          'name="OpenAI"',
          'base_url="https://api.openai.com/v1"',
          'wire_api="responses"',
          "requires_openai_auth=false",
          "supports_websockets=false",
          "request_max_retries=0",
          "stream_max_retries=0",
        ].join("\n"),
      );
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_prompt_build",
            handler: () => ({ systemPrompt: "Reply with only COMPACT_READY. Do not use tools." }),
          },
        ]),
      );
      const factory: CodexAppServerClientFactory = async (options) => {
        options?.assertCurrent?.();
        expect(options?.preparedAuth).toBeUndefined();
        expect(options?.authRequirement).toBeUndefined();
        expect(options?.authProfileId ?? null).toBeNull();
        const startOptions = options?.startOptions;
        assert(startOptions);
        expect(startOptions.commandSource).toBe("managed");
        if (!client) {
          client = await createIsolatedCodexAppServerClient({
            ...options,
            startOptions: {
              ...startOptions,
              transport: "stdio",
              args: startOptions.args ?? ["app-server"],
              cwd: native.cwd,
              headers: {},
              env: childEnv,
              clearEnv: Object.keys(process.env).filter((name) => !(name in childEnv)),
            },
          });
          const identity = readCodexAppServerClientProcessIdentity(client);
          assert(identity?.nativeCommand);
          expect(identity.commandSource).toBe("resolved-managed");
          expect(await fs.realpath(identity.nativeCommand)).toBe(await fs.realpath(native.command));
        }
        return client;
      };
      const compactImplementation = compactionRuntime.maybeCompactCodexAppServerSession;
      vi.spyOn(compactionRuntime, "maybeCompactCodexAppServerSession").mockImplementation(
        (params, options) =>
          compactImplementation(params, {
            ...options,
            clientFactory: factory,
            nativeCompletionTimeoutMs: 45_000,
            nativeInterruptGraceMs: 10_000,
          }),
      );
      const params = createParams(path.join(tempDir, "session.jsonl"), native.cwd, {
        runId: "native-compaction-setup",
        prompt: "Reply with only COMPACT_READY. Do not use tools.",
      });
      params.agentDir = path.join(tempDir, "agent");
      params.modelId = MODEL;
      params.model = { ...params.model, id: MODEL, name: MODEL };
      const runtimePlan = createCodexRuntimePlanFixture();
      params.runtimePlan = {
        ...runtimePlan,
        observability: {
          ...runtimePlan.observability,
          modelId: MODEL,
          resolvedRef: `codex/${MODEL}`,
        },
      };
      params.timeoutMs = 45_000;
      params.permissionMode = "full";
      setCodexTestModelSupportsTools(params, true);
      setAgentWorkspaceForTest(params, native.cwd);
      closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
      const pluginConfig = { appServer: { homeScope: "user", args: ["app-server"] } };
      const setup = await runCodexAppServerAttempt(params, {
        clientFactory: factory,
        pluginConfig,
      });
      expect(setup.assistantTexts.join("\n").trim()).toBe("COMPACT_READY");
      expect(readAttemptTerminal(setup)).toMatchObject({
        aborted: false,
        timedOut: false,
        promptError: null,
      });
      assert(client);
      summary.nativeVersion = client.getRuntimeIdentity()?.serverVersion ?? "";
      expect(summary.nativeVersion).toBe(CODEX_APP_SERVER_VERSION);
      const setupHost = params.hostCapabilities;
      closeHost();
      closeHost = undefined;
      expect(() => setupHost.assertActive()).toThrow("no longer active");
      summary.setupHostClosed = true;

      const compactionHostParams = { ...params, runId: "native-compaction-admission" };
      closeHost = await bindProductionHarnessHostCapabilitiesForTest(compactionHostParams);
      const compactionHost = compactionHostParams.hostCapabilities;
      expect(compactionHost).not.toBe(setupHost);
      compactionHost.assertActive();
      const retainSourceAuthority = compactionHost.retainSourceAuthority;
      assert(retainSourceAuthority);
      transport.phase = "compaction";
      const harness = createCodexAppServerAgentHarness({
        bindingStore: testCodexAppServerBindingStore,
        pluginConfig,
      });
      assert(typeof harness.compact === "function");
      const compactParams: AgentHarnessCompactParams<2> = {
        runId: compactionHostParams.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
        sessionTarget: params.sessionTarget,
        agentId: params.agentId,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        config: params.config,
        provider: params.provider,
        model: params.modelId,
        runtimeModel: params.model,
        runtimePlan: params.runtimePlan,
        contextTokenBudget: params.contextTokenBudget,
        permissionMode: params.permissionMode,
        thinkLevel: params.thinkLevel,
        abortSignal: params.abortSignal,
        hostCapabilities: {
          kind: compactionHost.kind,
          version: compactionHost.version,
          assertActive: compactionHost.assertActive,
          retainSourceAuthority,
        },
        trigger: "manual",
      };
      const compacted = await harness.compact(compactParams);
      summary.compacted = compacted?.compacted === true;
      expect(compacted).toMatchObject({ ok: true, compacted: true });
      expect(transport.requests.map((request) => request.requestKind)).toEqual([
        "turn",
        "compaction",
      ]);
      const [setupRequest, compactRequest] = transport.requests;
      assert(setupRequest && compactRequest);
      expect(compactRequest.threadId).toBe(setupRequest.threadId);
      expect(compactRequest.turnId).not.toBe(setupRequest.turnId);
    } finally {
      try {
        if (client) {
          const closed = await client.closeAndWait();
          summary.nativeExited = closed.exited;
          expect(closed).toMatchObject({ exited: true });
        }
      } finally {
        closeHost?.();
        console.info("NATIVE_COMPACTION_PROOF " + JSON.stringify(summary));
      }
    }
  },
);
