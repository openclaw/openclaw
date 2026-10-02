import path from "node:path";
import {
  AgentHarnessPreflightError,
  type AgentHarnessAttemptParamsV2,
  type AgentExecutorController,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import * as harnessRuntime from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentsApiBinding } from "./agentsapi-bindings.js";
import { AgentsApiClient, type AgentsApiInputFile } from "./agentsapi-client.js";
import { createModel, createTurn } from "./agentsapi.test-support.js";
import plugin from "./index.js";

const { createSession, fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  createSession: vi.fn<typeof import("./agentsapi-session.js").createAgentsApiSession>(),
  fetchWithSsrFGuardMock:
    vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
}));

// Keep the registered harness, input formatting, host generation, binding lifecycle,
// SQLite stores, and input file preparation real; provider execution stays mocked.
vi.mock("./agentsapi-session.js", () => ({ createAgentsApiSession: createSession }));
vi.mock("./agentsapi-prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agentsapi-prompt.js")>()),
  buildAgentsApiInstructions: async () => "Fixture instructions",
}));
vi.mock("./agentsapi-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agentsapi-files.js")>()),
  prepareSelfHostedInputs: async () => ({ files: [], mappingText: "" }),
  collectOutputs: async () => [],
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

beforeEach(() => {
  fetchWithSsrFGuardMock.mockReset().mockImplementation(() => {
    throw new Error("Unexpected live request in the Agents API persistence fixture");
  });
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
  createSession.mockImplementation((options) => {
    const turn = createTurn({ id: `turn-${options.sessionId}`, session_id: options.sessionId });
    return {
      isAvailable: () => false,
      isSettled: () => true,
      wasSubmitted: () => true,
      queueMessage: async () => {},
      readUsageTurns: async () => [],
      run: async (prompt, persistInput, onSubmitted) => {
        await persistInput();
        await options.client.message(options.sessionId, prompt, options.signal);
        onSubmitted();
        options.onSettled?.();
        return { turn, cancelled: false, terminatedByTool: false };
      },
      close: async () => {},
      reconcileAfterClose: async () => turn,
    };
  });
});

afterEach(() => {
  createSession.mockReset();
  resetPluginStateStoreForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("reopens an existing hosted binding and requires reset before persisting a fresh self-hosted session", async () => {
  await withOpenClawTestState({ label: "agentsapi-binding-persistence" }, async (state) => {
    const params = await createAttempt(state.stateDir);
    const storeOptions = {
      namespace: "agentsapi-sessions",
      maxEntries: 100_000,
      overflowPolicy: "reject-new" as const,
      env: state.env,
    };
    const openStore = () =>
      createPluginStateKeyedStoreForTests<AgentsApiBinding>("agentsapi", storeOptions);
    // Saved configuration identity: SHA-256 of ["fixture-model"].
    const hosted = {
      sessionId: "persisted-hosted-session",
      configFingerprint: "7279f68deebd4e52eb136c95ccbb8c642a7f141b836a33de22c8aa9a4a93c022",
    };
    await openStore().register(params.sessionId, hosted);
    await reopenState();

    const { create, update, message } = mockClient("fresh-self-hosted-session");

    let config: OpenClawConfig = {};
    const register = () => registerHarness(state.env, () => config);
    let harness = register();
    try {
      expect(await harness.runAttempt(params)).toEqual(
        expect.objectContaining({ terminal: { kind: "ok" } }),
      );
      expect(await openStore().lookup(params.sessionId)).toEqual(hosted);
      expect(message).toHaveBeenCalledExactlyOnceWith(
        hosted.sessionId,
        expect.stringContaining(params.prompt),
        expect.any(AbortSignal),
      );
      expect(create).toHaveBeenCalledTimes(0);

      config = { plugins: { entries: { agentsapi: { config: { environment: "self_hosted" } } } } };
      const rejected = await harness.runAttempt({ ...params, runId: "switched-run" });
      expect(rejected).toMatchObject({
        terminal: {
          kind: "failed",
          error: expect.objectContaining({
            message:
              "Agents API model, environment, or MCP configuration changed; reset the OpenClaw session before continuing",
          }),
        },
      });
      expect([
        create.mock.calls.length,
        update.mock.calls.length,
        message.mock.calls.length,
      ]).toEqual([0, 1, 1]);
      expect(await openStore().lookup(params.sessionId)).toEqual(hosted);

      await harness.reset({ sessionId: params.sessionId, reason: "reset" });
      await harness.dispose();
      await reopenState();
      harness = register();
      expect(await harness.runAttempt({ ...params, runId: "reset-run" })).toEqual(
        expect.objectContaining({ terminal: { kind: "ok" } }),
      );
      expect(create).toHaveBeenCalledExactlyOnceWith(
        expect.any(AbortSignal),
        "Fixture instructions",
        "fixture-model",
        expect.objectContaining({
          environment: { type: "self_hosted", workspace_directory: params.workspaceDir },
        }),
      );
      const fresh = await openStore().lookup(params.sessionId);
      expect(fresh).toMatchObject({
        sessionId: "fresh-self-hosted-session",
        configFingerprint: expect.any(String),
      });
      await harness.dispose();
      await reopenState();
      expect(await openStore().lookup(params.sessionId)).toEqual(fresh);
      harness = register();
      expect(await harness.runAttempt({ ...params, runId: "reopened-self-hosted-run" })).toEqual(
        expect.objectContaining({ terminal: { kind: "ok" } }),
      );
      expect(create).toHaveBeenCalledTimes(1);
      expect(message.mock.calls.map(([sessionId]) => sessionId)).toEqual([
        hosted.sessionId,
        "fresh-self-hosted-session",
        "fresh-self-hosted-session",
      ]);
    } finally {
      await harness.dispose();
    }
  });
});

it("continues inline images with an oversized original and the following turn on the same native session", async () => {
  await withOpenClawTestState({ label: "agentsapi-image-recovery" }, async (state) => {
    const params = await createAttempt(state.stateDir);
    const { create, message } = mockClient("image-session");

    const original = await saveMediaBuffer(
      Buffer.alloc(5 * 1024 * 1024 + 1, 32),
      "application/pdf",
      "inbound",
      5 * 1024 * 1024 + 1,
      "brief.pdf",
    );
    const prompt = "Summarize the supplied extracted text: the launch window is October.";
    const harness = registerHarness(state.env);
    try {
      const result = await harness.runAttempt({
        ...params,
        prompt,
        media: [{ path: original.path, sizeBytes: 1 }],
        images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
      });
      expect(result).toMatchObject({ terminal: { kind: "ok" } });
      const input = message.mock.calls[0]![1];
      expect(input).toContain(prompt);
      expect(input).toContain("The Agents API harness does not support inline image inputs.");
      expect(input).toContain(
        "No confirmed execution paths are available for this message's original attachments.",
      );
      expect(input).toContain("ask for a text description if the image is necessary");
      expect(input).toContain(
        "Input attachment feedback: 1 attachment(s) were not transferred to the hosted VM.",
      );
      expect(input).toContain("exceeds the 5 MiB file limit");
      expect(input).toContain("ask for a smaller attachment or the relevant text");
      expect(create.mock.calls[0]?.[3]?.files).toEqual([]);
      expect(await harness.runAttempt({ ...params, runId: "following-turn" })).toMatchObject({
        terminal: { kind: "ok" },
      });
      expect(message.mock.calls.map(([sessionId]) => sessionId)).toEqual([
        "image-session",
        "image-session",
      ]);
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      await harness.dispose();
    }
  });
});

it("skips canonical empty media slots while preserving numbered originals and source validation", async () => {
  await withOpenClawTestState({ label: "agentsapi-empty-media-slots" }, async (state) => {
    const params = await createAttempt(state.stateDir);
    const { create, message } = mockClient("sparse-session");
    const upload = vi
      .spyOn(AgentsApiClient.prototype, "uploadFile")
      .mockResolvedValue({ status: "uploaded" });
    // Canonical hydration keeps serialized null slots as empty positional facts.
    const empty = { transcribed: false };
    let media: NonNullable<AgentHarnessAttemptParamsV2["media"]> = Array.from(
      { length: 51 },
      () => empty,
    );
    const hostCapabilities = {
      ...params.hostCapabilities,
      resolveInputAttachmentMedia: async () => media,
    };
    const harness = registerHarness(state.env);
    try {
      expect(await harness.runAttempt({ ...params, hostCapabilities })).toMatchObject({
        terminal: { kind: "ok" },
      });
      expect(create.mock.calls[0]?.[3]?.files).toEqual([]);
      expect(message.mock.calls[0]?.[1]).toContain(params.prompt);
      expect(message.mock.calls[0]?.[1]).not.toContain("Input attachment feedback:");

      const bytes = Buffer.from("The launch window is October.");
      const saved = await saveMediaBuffer(bytes, "text/plain", "inbound");
      media = [
        ...Array.from({ length: 50 }, () => empty),
        { url: `media://inbound/${saved.id}`, fileName: "brief.txt" },
      ];
      expect(
        await harness.runAttempt({ ...params, hostCapabilities, runId: "sparse-file-turn" }),
      ).toMatchObject({
        terminal: { kind: "ok" },
      });
      expect(upload).toHaveBeenCalledTimes(1);
      const file = upload.mock.calls[0]![1];
      expect(Buffer.from(file.data, "base64")).toEqual(bytes);
      expect(message.mock.calls[1]?.[1]).toContain(
        JSON.stringify([{ attachment: 51, name: "brief.txt", path: file.path }]),
      );

      media = [{ contentType: "image/png" }];
      expect(
        await harness.runAttempt({ ...params, hostCapabilities, runId: "missing-source-turn" }),
      ).toMatchObject({
        terminal: {
          kind: "failed",
          error: expect.objectContaining({
            message: "Agents API input attachment requires a host-prepared managed media source",
          }),
        },
      });
      expect(create).toHaveBeenCalledTimes(1);
      expect(message.mock.calls.map(([sessionId]) => sessionId)).toEqual([
        "sparse-session",
        "sparse-session",
      ]);
    } finally {
      await harness.dispose();
    }
  });
});

it.each([
  { availability: "connected", uploadsBeforeDisconnect: 2 },
  { availability: "disconnected after a partial upload", uploadsBeforeDisconnect: 1 },
])(
  "continues with original attachments on the same $availability hosted session",
  async ({ uploadsBeforeDisconnect }) => {
    await withOpenClawTestState({ label: "agentsapi-original-images" }, async (state) => {
      const params = await createAttempt(state.stateDir);
      const { create, message } = mockClient("image-session");
      const upload = vi.spyOn(AgentsApiClient.prototype, "uploadFile");
      let uploadedCount = 0;
      fetchWithSsrFGuardMock.mockImplementation(async ({ url, init, beforeRequest }) => {
        beforeRequest?.();
        const request = new Request(url, init);
        const pathname = new URL(url).pathname;
        let response: Response;
        if (pathname === "/v1/agents/sessions/image-session") {
          response = Response.json({
            id: "image-session",
            environment: { type: "openai_hosted", id: "image-environment" },
          });
        } else if (pathname === "/v1/agents/environments/image-environment") {
          response = Response.json({
            id: "image-environment",
            type: "openai_hosted",
            status: uploadedCount < uploadsBeforeDisconnect ? "connected" : "disconnected",
          });
        } else if (
          pathname === "/v1/agents/environments/image-environment/files" &&
          request.method === "POST"
        ) {
          const file: AgentsApiInputFile = await request.json();
          uploadedCount++;
          response = Response.json({
            environment_id: "image-environment",
            path: file.path,
            size_bytes: Buffer.from(file.data, "base64").length,
          });
        } else {
          throw new Error(`Unexpected fixture request: ${request.method} ${pathname}`);
        }
        return { response, finalUrl: url, release: async () => {} };
      });
      const image = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
        "base64",
      );
      const originals = ["first", "replacement", "companion"].map((label) =>
        Buffer.concat([image, Buffer.from(label)]),
      );
      const harness = registerHarness(state.env);
      try {
        for (const [index, batch] of [[originals[0]!], originals.slice(1)].entries()) {
          const media = await Promise.all(
            batch.map(async (bytes) => {
              const saved = await saveMediaBuffer(bytes, "image/png", "inbound");
              return { url: `media://inbound/${saved.id}`, fileName: "scene.png" };
            }),
          );
          const result = await harness.runAttempt({
            ...params,
            runId: `image-turn-${index}`,
            prompt: "Describe the current attachments, including the replacement image.",
            images: [{ type: "image", data: image.toString("base64"), mimeType: "image/png" }],
            hostCapabilities: {
              ...params.hostCapabilities,
              resolveInputAttachmentMedia: async () => media,
            },
          });
          expect(result).toMatchObject({ terminal: { kind: "ok" } });
        }
        const firstFile = create.mock.calls[0]?.[3]?.files?.[0];
        expect(firstFile).toBeDefined();
        expect(Buffer.from(firstFile!.data, "base64")).toEqual(originals[0]);
        expect(message.mock.calls[0]?.[1]).toContain(firstFile!.path);
        const attemptedFiles = upload.mock.calls.map(([, file]) => file);
        expect(attemptedFiles).toHaveLength(Math.min(uploadsBeforeDisconnect + 1, 2));
        expect(uploadedCount).toBe(uploadsBeforeDisconnect);
        expect(new Set([firstFile!, ...attemptedFiles].map((file) => file.path)).size).toBe(
          1 + attemptedFiles.length,
        );
        for (const [index, file] of attemptedFiles.entries()) {
          expect(path.posix.dirname(file.path)).toBe("/workspace/inputs");
          expect(path.posix.basename(file.path)).toMatch(/-scene\.png$/u);
          expect(Buffer.from(file.data, "base64")).toEqual(originals[index + 1]);
        }
        const input = message.mock.calls[1]![1];
        expect(input).toContain(
          "Describe the current attachments, including the replacement image.",
        );
        if (uploadsBeforeDisconnect === 2) {
          for (const file of attemptedFiles) {
            expect(input).toContain(file.path);
          }
        } else {
          expect(input).toContain("The hosted environment is unavailable for file uploads.");
          expect(input).toContain(
            "There are no confirmed hosted VM paths for this message's attachments",
          );
          expect(input).toContain(
            "Files retained from earlier turns do not establish the contents of these new attachments.",
          );
          expect(input).toContain("available Gateway tools that can access the originals");
          expect(input).toContain(
            "No confirmed execution paths are available for this message's original attachments.",
          );
          for (const file of attemptedFiles) {
            expect(input).not.toContain(file.path);
          }
        }
        expect(create).toHaveBeenCalledTimes(1);
        expect(message.mock.calls.map(([sessionId]) => sessionId)).toEqual([
          "image-session",
          "image-session",
        ]);
        for (const invocation of upload.mock.invocationCallOrder) {
          expect(invocation).toBeLessThan(message.mock.invocationCallOrder[1]!);
        }
      } finally {
        await harness.dispose();
      }
    });
  },
);

it("reports unsupported tool restrictions without replacing the bound native session", async () => {
  await withOpenClawTestState({ label: "agentsapi-tool-policy-preflight" }, async (state) => {
    const params = await createAttempt(state.stateDir);
    const { create, message } = mockClient("retained-session");

    const harness = registerHarness(state.env);
    try {
      expect(await harness.runAttempt(params)).toMatchObject({ terminal: { kind: "ok" } });
      const restricted = harness.runAttempt({
        ...params,
        runId: "restricted-run",
        pluginHarnessToolPolicyRestricted: true,
      });
      await expect(restricted).rejects.toBeInstanceOf(AgentHarnessPreflightError);
      await expect(restricted).rejects.toMatchObject({
        scope: "harness",
        userMessage:
          "Agents API cannot run with this chat's tool restrictions because it cannot enforce them on native tools. Choose a harness that supports these restrictions or update the tool settings.",
      });
      expect(create).toHaveBeenCalledTimes(1);
      expect(message).toHaveBeenCalledTimes(1);

      expect(await harness.runAttempt({ ...params, runId: "allowed-following-run" })).toMatchObject(
        {
          terminal: { kind: "ok" },
        },
      );
      expect(create).toHaveBeenCalledTimes(1);
      expect(message.mock.calls.map(([sessionId]) => sessionId)).toEqual([
        "retained-session",
        "retained-session",
      ]);
    } finally {
      await harness.dispose();
    }
  });
});

it.each([false, true])("reports Gateway sandbox placement with images: %s", async (withImages) => {
  await withOpenClawTestState({ label: "agentsapi-sandbox-preflight" }, async (state) => {
    const params = await createAttempt(state.stateDir);
    const harness = registerHarness(state.env);
    try {
      const pending = harness.runAttempt({
        ...params,
        sandbox: createSandboxTestContext(),
        images: withImages
          ? [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]
          : undefined,
      });
      await expect(pending).rejects.toBeInstanceOf(AgentHarnessPreflightError);
      await expect(pending).rejects.toMatchObject({
        scope: "harness",
        message: "Agents API does not support Gateway sandbox placement.",
        userMessage:
          "Agents API cannot run in the configured Gateway sandbox. Choose a harness that supports Gateway sandbox placement before retrying.",
      });
    } finally {
      await harness.dispose();
    }
  });
});

it("retains the executor binding after uncertain startup and waits for readiness before resuming it", async () => {
  await withOpenClawTestState({ label: "agentsapi-executor-recovery" }, async (state) => {
    const fixture = await executorFixture(state);
    let harness = fixture.createHarness();
    let savedBeforeStartup: AgentsApiBinding | undefined;
    fixture.controller.ensure.mockImplementationOnce(async () => {
      const stored = await fixture.openStore().lookup(fixture.params.sessionId);
      savedBeforeStartup = stored && {
        sessionId: stored.sessionId,
        configFingerprint: stored.configFingerprint,
        executorControllerPluginId: stored.executorControllerPluginId,
        executor: stored.executor,
      };
      throw new Error("Executor startup was not acknowledged");
    });
    try {
      expect(await harness.runAttempt(fixture.params)).toMatchObject({
        terminal: {
          kind: "failed",
          error: expect.objectContaining({ message: "Executor startup was not acknowledged" }),
        },
      });
      expect(savedBeforeStartup).toMatchObject({
        sessionId: "native-executor-session",
        executorControllerPluginId: "fixture-executor",
        executor: {
          sessionKey: fixture.params.sessionKey,
          agentId: "main",
          nativeSessionId: "native-executor-session",
          environmentId: "executor-environment",
          remoteUrl: "wss://executor.example.test/session",
          workspaceDirectory: "/executor/project",
        },
      });
      expect(fixture.create.mock.calls[0]?.[3]?.environment).toEqual({
        type: "self_hosted",
        workspace_directory: "/executor/project",
      });
      expect(fixture.message).not.toHaveBeenCalled();
      await harness.dispose();
      await reopenState();
      expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(
        savedBeforeStartup,
      );

      harness = fixture.createHarness();
      const readinessRequested = Promise.withResolvers<void>();
      const readiness =
        Promise.withResolvers<Awaited<ReturnType<AgentsApiClient["environment"]>>>();
      fixture.environment.mockImplementationOnce(async () => {
        readinessRequested.resolve();
        return await readiness.promise;
      });
      const resumed = harness.runAttempt({ ...fixture.params, runId: "recovered-executor-run" });
      try {
        await Promise.race([
          readinessRequested.promise,
          resumed.then(() => {
            throw new Error("The attempt finished without waiting for executor readiness");
          }),
        ]);
        expect(fixture.message).not.toHaveBeenCalled();
      } finally {
        readiness.resolve(connectedEnvironment());
      }
      expect(await resumed).toMatchObject({ terminal: { kind: "ok" } });
      expect(fixture.create).toHaveBeenCalledTimes(1);
      expect(fixture.controller.ensure.mock.calls.map(([binding]) => binding)).toEqual([
        savedBeforeStartup?.executor,
        savedBeforeStartup?.executor,
      ]);
      expect(fixture.message).toHaveBeenCalledExactlyOnceWith(
        "native-executor-session",
        expect.stringContaining(fixture.params.prompt),
        expect.any(AbortSignal),
      );
    } finally {
      await harness.dispose();
    }
  });
});

it("settles native work before reset and retains the binding when executor retirement fails", async () => {
  await withOpenClawTestState({ label: "agentsapi-executor-reset" }, async (state) => {
    const fixture = await executorFixture(state);
    const harness = fixture.createHarness();
    try {
      expect(await harness.runAttempt(fixture.params)).toMatchObject({ terminal: { kind: "ok" } });
      const saved = await fixture.openStore().lookup(fixture.params.sessionId);
      fixture.events.length = 0;
      fixture.session.mockResolvedValue({ ...fixture.nativeSession, status: "in_progress" });
      fixture.controller.retire.mockImplementationOnce(async () => {
        fixture.events.push("retire");
        expect(await fixture.openStore().lookup(fixture.params.sessionId)).toMatchObject(saved!);
        throw new Error("Executor retirement was not acknowledged");
      });

      await expect(
        harness.reset({ sessionId: fixture.params.sessionId, reason: "reset" }),
      ).rejects.toThrow("Executor retirement was not acknowledged");
      expect(fixture.events).toEqual(["cancel", "retire"]);
      expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(saved);

      await harness.reset({ sessionId: fixture.params.sessionId, reason: "reset" });
      expect(fixture.events).toEqual(["cancel", "retire", "cancel", "retire"]);
      expect(fixture.controller.retire.mock.calls.map(([binding]) => binding)).toEqual([
        saved?.executor,
        saved?.executor,
      ]);
      // The released lease leaves either an empty tombstone or an expired row.
      expect((await fixture.openStore().lookup(fixture.params.sessionId)) ?? {}).toEqual({});
    } finally {
      await harness.dispose();
    }
  });
});

it("can reset a retained executor after a restarted harness rejects a configuration change", async () => {
  await withOpenClawTestState({ label: "agentsapi-executor-config-reset" }, async (state) => {
    const fixture = await executorFixture(state);
    let harness = fixture.createHarness();
    try {
      expect(await harness.runAttempt(fixture.params)).toMatchObject({ terminal: { kind: "ok" } });
      const saved = await fixture.openStore().lookup(fixture.params.sessionId);
      await harness.dispose();
      await reopenState();
      vi.spyOn(fixture.runtime.config, "current").mockReturnValue({
        plugins: { entries: { agentsapi: { config: { environment: "openai_hosted" } } } },
      });
      harness = fixture.createHarness();

      const rejected = await harness.runAttempt({ ...fixture.params, runId: "changed-config-run" });
      expect(rejected).toMatchObject({
        terminal: {
          kind: "failed",
          error: expect.objectContaining({
            message:
              "Agents API executor controller changed; reset the OpenClaw session before continuing",
          }),
        },
      });
      expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(saved);

      await harness.reset({ sessionId: fixture.params.sessionId, reason: "reset" });
      expect(fixture.controller.retire).toHaveBeenCalledExactlyOnceWith(
        saved?.executor,
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          assertCurrent: expect.any(Function),
        }),
      );
      // The released lease leaves either an empty tombstone or an expired row.
      expect((await fixture.openStore().lookup(fixture.params.sessionId)) ?? {}).toEqual({});
      expect(fixture.create).toHaveBeenCalledTimes(1);
    } finally {
      await harness.dispose();
    }
  });
});

it("rejects an unavailable selected controller before allocating a native session", async () => {
  await withOpenClawTestState({ label: "agentsapi-executor-selection" }, async (state) => {
    const fixture = await executorFixture(state);
    fixture.resolveController.mockImplementation(() => {
      throw new Error(
        'Agent executor controller plugin "fixture-executor" is missing, disabled, or unavailable',
      );
    });
    const harness = fixture.createHarness();
    try {
      expect(await harness.runAttempt(fixture.params)).toMatchObject({
        terminal: {
          kind: "failed",
          error: expect.objectContaining({
            message:
              'Agent executor controller plugin "fixture-executor" is missing, disabled, or unavailable',
          }),
        },
      });
      expect(fixture.create.mock.calls).toEqual([]);
      // The released lease leaves either an empty tombstone or an expired row.
      expect((await fixture.openStore().lookup(fixture.params.sessionId)) ?? {}).toEqual({});
    } finally {
      await harness.dispose();
    }
  });
});

it("requires reset before a controller can replace an externally managed session", async () => {
  await withOpenClawTestState({ label: "agentsapi-executor-external-owner" }, async (state) => {
    const fixture = await executorFixture(state);
    fixture.controller.workspaceDirectory = fixture.params.workspaceDir;
    const config = vi.spyOn(fixture.runtime.config, "current").mockReturnValue({
      plugins: { entries: { agentsapi: { config: { environment: "self_hosted" } } } },
    });
    const harness = fixture.createHarness();
    try {
      expect(await harness.runAttempt(fixture.params)).toMatchObject({ terminal: { kind: "ok" } });
      const saved = await fixture.openStore().lookup(fixture.params.sessionId);
      config.mockRestore();
      expect(
        await harness.runAttempt({ ...fixture.params, runId: "controller-adoption-run" }),
      ).toMatchObject({
        terminal: {
          kind: "failed",
          error: expect.objectContaining({
            message:
              "Agents API executor controller changed; reset the OpenClaw session before continuing",
          }),
        },
      });
      expect(fixture.controller.ensure.mock.calls).toEqual([]);
      expect(fixture.create).toHaveBeenCalledTimes(1);
      expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(saved);
    } finally {
      await harness.dispose();
    }
  });
});

it("cleans up with the stored controller after selecting a different registered owner", async () => {
  await withOpenClawTestState({ label: "agentsapi-executor-original-owner" }, async (state) => {
    const fixture = await executorFixture(state);
    const other = {
      ...fixture.controller,
      ensure: vi.fn(async () => {}),
      retire: vi.fn(async () => {}),
    };
    fixture.resolveController.mockImplementation((id) =>
      id === "other-executor" ? other : fixture.controller,
    );
    const harness = fixture.createHarness();
    try {
      expect(await harness.runAttempt(fixture.params)).toMatchObject({ terminal: { kind: "ok" } });
      const saved = await fixture.openStore().lookup(fixture.params.sessionId);
      vi.spyOn(fixture.runtime.config, "current").mockReturnValue({
        plugins: {
          entries: {
            agentsapi: {
              config: { environment: "self_hosted", executorController: "other-executor" },
            },
          },
        },
      });
      expect(
        await harness.runAttempt({ ...fixture.params, runId: "controller-replacement-run" }),
      ).toMatchObject({
        terminal: {
          kind: "failed",
          error: expect.objectContaining({
            message:
              "Agents API executor controller changed; reset the OpenClaw session before continuing",
          }),
        },
      });
      await harness.reset({ sessionId: fixture.params.sessionId, reason: "reset" });
      expect(fixture.controller.retire).toHaveBeenCalledExactlyOnceWith(
        saved?.executor,
        expect.any(Object),
      );
      expect(other.ensure.mock.calls).toEqual([]);
      expect(other.retire.mock.calls).toEqual([]);
      // The released lease leaves either an empty tombstone or an expired row.
      expect((await fixture.openStore().lookup(fixture.params.sessionId)) ?? {}).toEqual({});
    } finally {
      await harness.dispose();
    }
  });
});

it("retains earlier controlled bindings and explains the required upgrade cutover", async () => {
  await withOpenClawTestState({ label: "agentsapi-executor-legacy-owner" }, async (state) => {
    const fixture = await executorFixture(state);
    let harness = fixture.createHarness();
    try {
      expect(await harness.runAttempt(fixture.params)).toMatchObject({ terminal: { kind: "ok" } });
      const legacy = { ...(await fixture.openStore().lookup(fixture.params.sessionId))! };
      delete legacy.executorControllerPluginId;
      await fixture.openStore().register(fixture.params.sessionId, legacy);
      await harness.dispose();
      await reopenState();
      harness = fixture.createHarness();
      await expect(
        harness.runAttempt({ ...fixture.params, runId: "ownerless-controller-run" }),
      ).rejects.toThrow(
        "Agents API executor binding predates plugin ownership; retire this session with the previous version before upgrading",
      );
      await expect(
        harness.reset({ sessionId: fixture.params.sessionId, reason: "reset" }),
      ).rejects.toThrow(
        "Agents API executor binding predates plugin ownership; retire this session with the previous version before upgrading",
      );
      expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(legacy);
      expect(fixture.create).toHaveBeenCalledTimes(1);
    } finally {
      await harness.dispose();
    }
  });
});

it("preserves an owned executor binding when its deployment controller is unavailable", async () => {
  await withOpenClawTestState({ label: "agentsapi-executor-missing-controller" }, async (state) => {
    const fixture = await executorFixture(state);
    let harness = fixture.createHarness();
    try {
      expect(await harness.runAttempt(fixture.params)).toMatchObject({ terminal: { kind: "ok" } });
      const saved = await fixture.openStore().lookup(fixture.params.sessionId);
      await harness.dispose();
      await reopenState();
      fixture.resolveController.mockImplementation(() => {
        throw new Error(
          'Agent executor controller plugin "fixture-executor" is missing, disabled, or unavailable',
        );
      });
      harness = requireExecutorHarness(fixture.runtime);
      const rejected = await harness.runAttempt({
        ...fixture.params,
        runId: "missing-controller-run",
      });
      expect(rejected).toMatchObject({
        terminal: {
          kind: "failed",
          error: expect.objectContaining({
            message:
              'Agent executor controller plugin "fixture-executor" is missing, disabled, or unavailable',
          }),
        },
      });
      await expect(
        harness.reset({ sessionId: fixture.params.sessionId, reason: "reset" }),
      ).rejects.toThrow(
        'Agent executor controller plugin "fixture-executor" is missing, disabled, or unavailable',
      );
      const deleteSession = vi.fn(async () => {});
      await expect(
        harness.withSessionDeletion(
          { ...fixture.params.sessionTarget!, assertCurrent: () => {} },
          deleteSession,
        ),
      ).rejects.toThrow(
        'Agent executor controller plugin "fixture-executor" is missing, disabled, or unavailable',
      );
      expect(deleteSession).not.toHaveBeenCalled();
      expect(fixture.message).toHaveBeenCalledTimes(1);
      expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(saved);
    } finally {
      await harness.dispose();
    }
  });
});

it.each([false, true])(
  "retires an executor before session deletion and preserves rollback recovery (rollback: %s)",
  async (rollback) => {
    await withOpenClawTestState({ label: "agentsapi-executor-delete" }, async (state) => {
      const fixture = await executorFixture(state);
      const harness = fixture.createHarness();
      try {
        expect(await harness.runAttempt(fixture.params)).toMatchObject({
          terminal: { kind: "ok" },
        });
        const saved = await fixture.openStore().lookup(fixture.params.sessionId);
        fixture.events.length = 0;
        fixture.session.mockResolvedValue({ ...fixture.nativeSession, status: "in_progress" });

        await harness.withSessionDeletion(
          { ...fixture.params.sessionTarget!, assertCurrent: () => {} },
          async (mutation) => {
            expect(fixture.events).toEqual(["cancel", "retire"]);
            mutation.commit();
            fixture.events.push("commit");
            if (rollback) {
              mutation.rollback();
              fixture.events.push("rollback");
            }
          },
        );

        expect(fixture.events).toEqual(
          rollback ? ["cancel", "retire", "commit", "rollback"] : ["cancel", "retire", "commit"],
        );
        expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(
          rollback ? saved : undefined,
        );
        if (rollback) {
          await harness.withSessionDeletion(
            { ...fixture.params.sessionTarget!, assertCurrent: () => {} },
            async (mutation) => mutation.commit(),
          );
          expect(fixture.controller.retire.mock.calls.map(([binding]) => binding)).toEqual([
            saved?.executor,
            saved?.executor,
          ]);
          expect(await fixture.openStore().lookup(fixture.params.sessionId)).toBeUndefined();
        }
      } finally {
        await harness.dispose();
      }
    });
  },
);

it("preserves the executor binding and skips session deletion when retirement fails", async () => {
  await withOpenClawTestState({ label: "agentsapi-executor-delete-failure" }, async (state) => {
    const fixture = await executorFixture(state);
    const harness = fixture.createHarness();
    try {
      expect(await harness.runAttempt(fixture.params)).toMatchObject({ terminal: { kind: "ok" } });
      const saved = await fixture.openStore().lookup(fixture.params.sessionId);
      fixture.controller.retire.mockRejectedValueOnce(
        new Error("Executor retirement was not acknowledged"),
      );
      const deleteSession = vi.fn(async () => {});
      const target = { ...fixture.params.sessionTarget!, assertCurrent: () => {} };

      await expect(harness.withSessionDeletion(target, deleteSession)).rejects.toThrow(
        "Executor retirement was not acknowledged",
      );
      expect(deleteSession).not.toHaveBeenCalled();
      expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(saved);

      await harness.withSessionDeletion(target, async (mutation) => mutation.commit());
      expect(fixture.controller.retire.mock.calls.map(([binding]) => binding)).toEqual([
        saved?.executor,
        saved?.executor,
      ]);
      expect(await fixture.openStore().lookup(fixture.params.sessionId)).toBeUndefined();
    } finally {
      await harness.dispose();
    }
  });
});

function registerHarness(env: NodeJS.ProcessEnv, readConfig: () => OpenClawConfig = () => ({})) {
  const runtime = createBindingRuntime(env, readConfig);
  const registerAgentHarness = vi.fn<OpenClawPluginApi["registerAgentHarness"]>();
  plugin.register(createTestPluginApi({ id: "agentsapi", runtime, registerAgentHarness }));
  const harness = registerAgentHarness.mock.calls[0]?.[0];
  if (!harness?.runAttempt || !harness.reset || !harness.dispose) {
    throw new Error("The registered Agents API harness requires run, reset, and disposal");
  }
  return {
    runAttempt: harness.runAttempt.bind(harness),
    reset: harness.reset.bind(harness),
    dispose: harness.dispose.bind(harness),
  };
}

async function executorFixture(state: { stateDir: string; env: NodeJS.ProcessEnv }) {
  const params = await createAttempt(state.stateDir);
  const runtime = createBindingRuntime(state.env, () => ({
    plugins: {
      entries: {
        agentsapi: {
          config: { environment: "self_hosted", executorController: "fixture-executor" },
        },
      },
    },
  }));
  const openStore = () =>
    createPluginStateKeyedStoreForTests<AgentsApiBinding>("agentsapi", {
      namespace: "agentsapi-sessions",
      maxEntries: 100_000,
      overflowPolicy: "reject-new",
      env: state.env,
    });
  const events: string[] = [];
  const controller = {
    workspaceDirectory: "/executor/project",
    ensure: vi.fn<AgentExecutorController["ensure"]>(async () => {}),
    retire: vi.fn<AgentExecutorController["retire"]>(async () => {
      events.push("retire");
    }),
  };
  const resolveController = vi
    .spyOn(harnessRuntime, "resolveAgentExecutorController")
    .mockImplementation((pluginId) => {
      if (pluginId !== "fixture-executor") {
        throw new Error(
          `Agent executor controller plugin "${pluginId}" is missing, disabled, or unavailable`,
        );
      }
      return controller;
    });
  const nativeSession: Awaited<ReturnType<AgentsApiClient["session"]>> = {
    id: "native-executor-session",
    agent: {
      id: "fixture-agent",
      instructions: "Fixture instructions",
      model: "fixture-model",
      multi_agent: { enabled: false, max_concurrent_subagents: null },
      name: null,
      reasoning: { effort: null, summary: null },
      service_tier: "auto",
      text: { format: { type: "text" }, verbosity: "medium" },
      tools: [],
    },
    created_at: 1,
    last_active_at: 2,
    metadata: {},
    object: "agent.session",
    status: "idle",
    error: null,
    usage: null,
    vault_ids: [],
    environment: {
      id: "executor-environment",
      type: "self_hosted",
      capability_directories: [],
      workspace_directory: "/executor/project",
      remote_url: "wss://executor.example.test/session",
    },
    required_actions: [],
  };
  const create = vi.spyOn(AgentsApiClient.prototype, "create").mockResolvedValue(nativeSession.id);
  const session = vi.spyOn(AgentsApiClient.prototype, "session").mockResolvedValue(nativeSession);
  const environment = vi
    .spyOn(AgentsApiClient.prototype, "environment")
    .mockResolvedValue(connectedEnvironment());
  const message = vi.spyOn(AgentsApiClient.prototype, "message").mockResolvedValue(undefined);
  vi.spyOn(AgentsApiClient.prototype, "cancel").mockImplementation(async () => {
    events.push("cancel");
  });
  vi.spyOn(AgentsApiClient.prototype, "setReasoningEffort").mockResolvedValue(undefined);
  vi.spyOn(AgentsApiClient.prototype, "items").mockResolvedValue([]);
  return {
    params,
    runtime,
    openStore,
    controller,
    nativeSession,
    create,
    session,
    environment,
    message,
    events,
    resolveController,
    createHarness: () => requireExecutorHarness(runtime),
  };
}

function requireExecutorHarness(runtime: PluginRuntime) {
  const registerAgentHarness = vi.fn<OpenClawPluginApi["registerAgentHarness"]>();
  plugin.register(createTestPluginApi({ id: "agentsapi", runtime, registerAgentHarness }));
  const harness = registerAgentHarness.mock.calls[0]?.[0];
  if (!harness?.runAttempt || !harness.reset || !harness.withSessionDeletion || !harness.dispose) {
    throw new Error("The Agents API harness requires run, reset, deletion, and disposal");
  }
  return {
    runAttempt: harness.runAttempt.bind(harness),
    reset: harness.reset.bind(harness),
    withSessionDeletion: harness.withSessionDeletion.bind(harness),
    dispose: harness.dispose.bind(harness),
  };
}

function createBindingRuntime(env: NodeJS.ProcessEnv, current: () => OpenClawConfig) {
  const runtime = createPluginRuntimeMock({ config: { current } });
  runtime.state.openKeyedStore = <T>(options: Parameters<typeof runtime.state.openKeyedStore>[0]) =>
    createPluginStateKeyedStoreForTests<T>("agentsapi", { ...options, env });
  runtime.state.openSyncKeyedStore = <T>(
    options: Parameters<typeof runtime.state.openSyncKeyedStore>[0],
  ) => createPluginStateSyncKeyedStoreForTests<T>("agentsapi", { ...options, env });
  return runtime;
}

function connectedEnvironment(): Awaited<ReturnType<AgentsApiClient["environment"]>> {
  return {
    id: "executor-environment",
    type: "self_hosted",
    status: "connected",
    object: "agent.environment",
    files: [],
    plugins: [],
    skills: [],
  };
}

async function reopenState() {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
}

async function createAttempt(stateDir: string): Promise<AgentHarnessAttemptParamsV2> {
  const target = {
    agentId: "main",
    sessionId: "local-persisted-session",
    sessionKey: "agent:main:persisted-session",
    storePath: path.join(stateDir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  const authStorage = AuthStorage.inMemory();
  return {
    ...target,
    sessionTarget: target,
    sessionFile: path.join(stateDir, "session.jsonl"),
    workspaceDir: stateDir,
    agentDir: stateDir,
    config: {},
    runId: "persisted-run",
    prompt: "Continue the retained conversation.",
    timeoutMs: 5_000,
    provider: "openai",
    modelId: "fixture-model",
    model: createModel(),
    resolvedApiKey: "fixture-not-a-real-api-key",
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    authProfileStore: { version: 1, profiles: {} },
    thinkLevel: "off",
    hostCapabilities: {
      kind: "agent-harness-host-capability",
      version: 1,
      assertActive: () => {},
      createToolSurfaceAsync: async () => [],
      bindToolSurface: (tools) => tools,
      runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
      requestApproval: async () => undefined,
      waitForApproval: async () => undefined,
    },
  };
}

function mockClient(sessionId: string) {
  const create = vi.spyOn(AgentsApiClient.prototype, "create").mockResolvedValue(sessionId);
  const update = vi.spyOn(AgentsApiClient.prototype, "setReasoningEffort").mockResolvedValue();
  const message = vi.spyOn(AgentsApiClient.prototype, "message").mockResolvedValue();
  vi.spyOn(AgentsApiClient.prototype, "items").mockResolvedValue([]);
  return { create, update, message };
}
