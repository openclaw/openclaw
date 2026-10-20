import path from "node:path";
import {
  AgentHarnessPreflightError,
  type AgentHarnessAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import * as harnessRuntime from "openclaw/plugin-sdk/agent-harness-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { Type } from "typebox";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentsApiBinding } from "./agentsapi-bindings.js";
import { AgentsApiClient, type AgentsApiInputFile } from "./agentsapi-client.js";
import { registerNativeLifecycleTests } from "./agentsapi-harness.lifecycle.test-helpers.js";
import { registerMigrationTests } from "./agentsapi-harness.migration.test-helpers.js";
import {
  createAttempt,
  externalSessionFixture,
  registerHarness,
  mockClient,
  reopenState,
} from "./agentsapi-harness.persistence.test-helpers.js";
import { createHostedSession, createTurn } from "./agentsapi.test-support.js";

const { createSession, fetchWithSsrFGuardMock, resolveProviderAuth } = vi.hoisted(() => ({
  createSession: vi.fn<typeof import("./agentsapi-session.js").createAgentsApiSession>(),
  resolveProviderAuth:
    vi.fn<typeof import("openclaw/plugin-sdk/provider-auth-runtime").resolveApiKeyForProvider>(),
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

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: resolveProviderAuth,
}));

beforeEach(() => {
  resolveProviderAuth.mockReset().mockResolvedValue({
    apiKey: "fixture-not-a-real-api-key",
    mode: "api-key",
    source: "fixture",
  });
  fetchWithSsrFGuardMock.mockReset().mockImplementation(() => {
    throw new Error("Unexpected live request in the Agents API persistence fixture");
  });
  // Keep harness deadlines virtual, but share real clocks and heartbeats with SQLite lease workers.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
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
  clearRuntimeConfigSnapshot();
  createSession.mockReset();
  resetPluginStateStoreForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each([
  { name: "defaults", forwarding: undefined, gateway: true, mcp: true },
  {
    name: "all forwarding disabled",
    forwarding: { gatewayTools: false, mcpServers: false },
    gateway: false,
    mcp: false,
  },
])("sends only enabled forwarding surfaces with $name", async ({ forwarding, gateway, mcp }) => {
  await withOpenClawTestState({ label: "agentsapi-forwarding-request" }, async (state) => {
    const params = await createAttempt(state.stateDir);
    const client = mockClient("session-fixture");
    // Exercise the official SDK's serialized create request, not a preassembled tool list.
    client.create.mockRestore();
    const requests: unknown[] = [];
    fetchWithSsrFGuardMock.mockImplementation(async ({ url, init, beforeRequest }) => {
      beforeRequest?.();
      expect(new URL(url).pathname).toBe("/v1/agents/sessions");
      requests.push(await new Request(url, init).json());
      return {
        response: Response.json({ id: "session-fixture" }),
        finalUrl: url,
        release: async () => {},
      };
    });
    const construct = vi.fn<
      NonNullable<AgentHarnessAttemptParamsV2["hostCapabilities"]["createToolSurfaceAsync"]>
    >(async () => {
      if (!gateway) {
        throw new Error("Disabled Gateway tools must not be constructed");
      }
      return [
        {
          name: "fixture_gateway",
          label: "Fixture Gateway tool",
          description: "Fixture Gateway function",
          parameters: Type.Object({}, { additionalProperties: false }),
          execute: async () => ({
            content: [{ type: "text", text: "Fixture result" }],
            details: {},
          }),
        },
      ];
    });
    const loadMcp = vi.spyOn(harnessRuntime, "loadAgentHarnessMcpConfig");
    if (!mcp) {
      loadMcp.mockRejectedValue(new Error("Disabled MCP discovery must not resolve credentials"));
    }
    vi.stubEnv("AGENTSAPI_FORWARDING_TEST_MISSING", undefined);
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      mcp: {
        servers: {
          fixture: {
            transport: "streamable-http",
            url: "https://mcp.example.test/mcp",
            headers: {
              Authorization: mcp
                ? "Bearer fixture-token"
                : "Bearer ${AGENTSAPI_FORWARDING_TEST_MISSING}",
            },
          },
        },
      },
    };
    const harness = registerHarness(state.env, () => ({
      plugins: { entries: { agentsapi: { config: { forwarding } } } },
    }));
    try {
      const run = (runId: string) =>
        harness.runAttempt({
          ...params,
          config,
          runId,
          // Match the native-only allowlist that does not itself disable MCP forwarding.
          ...(!gateway && !mcp
            ? {
                toolsAllow: [
                  "exec",
                  "process",
                  "read",
                  "write",
                  "edit",
                  "apply_patch",
                  "web_search",
                ],
              }
            : {}),
          hostCapabilities: { ...params.hostCapabilities, createToolSurfaceAsync: construct },
        });
      expect(await run("first-forwarding-run")).toMatchObject({ terminal: { kind: "ok" } });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        agent: {
          tools: [
            { type: "web_search", mode: "live" },
            { type: "programmatic_tool_calling", enabled: true },
            ...(mcp
              ? [
                  {
                    type: "mcp",
                    server_label: "fixture",
                    transport: {
                      type: "http",
                      server_url: "https://mcp.example.test/mcp",
                      headers: { Authorization: "Bearer fixture-token" },
                    },
                    connection_origin: "environment",
                  },
                ]
              : []),
            ...(gateway ? [{ type: "function", name: "fixture_gateway" }] : []),
          ],
        },
        environment: { type: "openai_hosted", files: [] },
      });
      if (!mcp) {
        config.mcp!.servers!.future = {
          transport: "streamable-http",
          url: "https://future.example.test/mcp",
        };
      }
      expect(await run("followup-forwarding-run")).toMatchObject({ terminal: { kind: "ok" } });
      expect(requests).toHaveLength(1);
      expect(client.message.mock.calls.map(([sessionId]) => sessionId)).toEqual([
        "session-fixture",
        "session-fixture",
      ]);
      expect(construct).toHaveBeenCalledTimes(gateway ? 2 : 0);
      expect(loadMcp).toHaveBeenCalledTimes(mcp ? 2 : 0);
    } finally {
      await harness.dispose();
    }
  });
});

it("retains immutable forwarding bindings across policy changes and permits explicit reset", async () => {
  await withOpenClawTestState({ label: "agentsapi-forwarding-reset" }, async (state) => {
    const params = await createAttempt(state.stateDir);
    const openStore = () =>
      createPluginStateKeyedStoreForTests<AgentsApiBinding>("agentsapi", {
        namespace: "agentsapi-sessions",
        maxEntries: 100_000,
        overflowPolicy: "reject-new",
        env: state.env,
      });
    const original = {
      sessionId: "original-native-session",
      configFingerprint: "7279f68deebd4e52eb136c95ccbb8c642a7f141b836a33de22c8aa9a4a93c022",
    };
    await openStore().register(params.sessionId, original);
    const client = mockClient("isolated-native-session");
    const cancel = vi.spyOn(AgentsApiClient.prototype, "cancel").mockResolvedValue();
    let forwarding = { gatewayTools: true, mcpServers: true };
    const register = () =>
      registerHarness(state.env, () => ({
        plugins: { entries: { agentsapi: { config: { forwarding } } } },
      }));
    let harness = register();
    try {
      // Explicit defaults must still accept the exact pre-policy persisted identity.
      expect(await harness.runAttempt(params)).toMatchObject({ terminal: { kind: "ok" } });
      for (const restricted of [
        { gatewayTools: false, mcpServers: true },
        { gatewayTools: true, mcpServers: false },
        { gatewayTools: false, mcpServers: false },
      ]) {
        forwarding = restricted;
        await expectForwardingChange(harness.runAttempt(params));
        expect(await openStore().lookup(params.sessionId)).toEqual(original);
      }
      expect(client.create).not.toHaveBeenCalled();
      expect(client.update).toHaveBeenCalledTimes(1);
      expect(client.message).toHaveBeenCalledTimes(1);
      // Cleanup must still work after restart, without accepting the new policy for resume.
      await harness.dispose();
      await reopenState();
      harness = register();
      client.session.mockResolvedValue({
        ...createHostedSession("in_progress"),
        id: original.sessionId,
      });
      await harness.reset({ ...params.sessionTarget, reason: "reset" });
      expect(cancel).toHaveBeenCalledExactlyOnceWith(original.sessionId, expect.any(AbortSignal));
      expect(await harness.runAttempt(params)).toMatchObject({ terminal: { kind: "ok" } });
      const isolated = await openStore().lookup(params.sessionId);
      expect(isolated).toMatchObject({ sessionId: "isolated-native-session" });
      expect(isolated?.configFingerprint).not.toBe(original.configFingerprint);
      forwarding = { gatewayTools: true, mcpServers: true };
      await expectForwardingChange(harness.runAttempt(params));
      expect(await openStore().lookup(params.sessionId)).toEqual(isolated);
      expect(client.create).toHaveBeenCalledTimes(1);
      expect(client.message).toHaveBeenCalledTimes(2);
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
      expectText(input, [
        prompt,
        "The Agents API harness does not support inline image inputs.",
        "No confirmed execution paths are available for this message's original attachments.",
        "ask for a text description if the image is necessary",
        "Input attachment feedback: 1 attachment(s) were not transferred to the hosted VM.",
        "exceeds the 5 MiB file limit",
        "ask for a smaller attachment or the relevant text",
      ]);
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

it("continues with original attachments on the same hosted session disconnected after a partial upload", async () => {
  const uploadsBeforeDisconnect = 1;
  await withOpenClawTestState({ label: "agentsapi-original-images" }, async (state) => {
    const params = await createAttempt(state.stateDir);
    const { create, message, session } = mockClient("image-session");
    // Attachment transport owns the session/environment lookup in this fixture.
    session.mockRestore();
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
        expect(result).toHaveProperty("terminal", { kind: "ok" });
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
      expectText(input, [
        "Describe the current attachments, including the replacement image.",
        "The hosted environment is unavailable for file uploads.",
        "There are no confirmed hosted VM paths for this message's attachments",
        "Files retained from earlier turns do not establish the contents of these new attachments.",
        "available Gateway tools that can access the originals",
        "No confirmed execution paths are available for this message's original attachments.",
      ]);
      for (const file of attemptedFiles) {
        expect(input).not.toContain(file.path);
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
});

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

it("reports Gateway sandbox placement with images", async () => {
  await withOpenClawTestState({ label: "agentsapi-sandbox-preflight" }, async (state) => {
    const params = await createAttempt(state.stateDir);
    const harness = registerHarness(state.env);
    try {
      const pending = harness.runAttempt({
        ...params,
        sandbox: createSandboxTestContext(),
        images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
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

it.each(["owned", "owner-only", "ownerless"] as const)(
  "retains a retired %s controller binding across run, reset, deletion, and context reset",
  async (kind) => {
    await withOpenClawTestState({ label: "agentsapi-retired-controller" }, async (state) => {
      const fixture = await externalSessionFixture(state);
      const saved = {
        sessionId: fixture.nativeSession.id,
        configFingerprint: "saved-config",
        ...(kind !== "ownerless" ? { executorControllerPluginId: "original-controller" } : {}),
        ...(kind !== "owner-only"
          ? {
              executor: {
                sessionKey: fixture.params.sessionKey,
                agentId: "main",
                nativeSessionId: fixture.nativeSession.id,
                environmentId: "executor-environment",
                remoteUrl: "wss://executor.example.test/session",
                workspaceDirectory: "/executor/project",
              },
            }
          : {}),
      };
      const openRawStore = () => fixture.openStore<Record<string, unknown>>();
      await openRawStore().register(fixture.params.sessionId, saved);
      await reopenState();
      const harness = fixture.createHarness();
      const target = { ...fixture.params.sessionTarget, assertCurrent: () => {} };
      const commit = vi.fn(async () => {});
      try {
        for (const operation of [
          () => harness.runAttempt(fixture.params),
          () => harness.reset({ ...target, reason: "reset" }),
          () => harness.withSessionDeletion(target, commit),
          () => harness.withSessionContextReset(target, commit),
        ]) {
          await expect(operation()).rejects.toThrow(
            "Retire this session with the previous OpenClaw version and original controller plugin before upgrading. The saved binding has been retained.",
          );
          expect(await openRawStore().lookup(fixture.params.sessionId)).toEqual(saved);
        }
        expect(commit).not.toHaveBeenCalled();
        expect(fixture.create).not.toHaveBeenCalled();
        expect(fixture.session).not.toHaveBeenCalled();
        expect(fixture.update).not.toHaveBeenCalled();
        expect(fixture.message).not.toHaveBeenCalled();
        expect(fixture.cancel).not.toHaveBeenCalled();
      } finally {
        await harness.dispose();
      }
    });
  },
);

registerNativeLifecycleTests(resolveProviderAuth);

it("preserves external session binding when delete cancel settlement fails and permits retry", async () => {
  await withOpenClawTestState({ label: "agentsapi-executor-settlement-failure" }, async (state) => {
    const fixture = await externalSessionFixture(state);
    const harness = fixture.createHarness();
    try {
      await harness.runAttempt(fixture.params);
      const saved = await fixture.openStore().lookup(fixture.params.sessionId);
      fixture.events.length = 0;
      fixture.session.mockResolvedValue({ ...fixture.nativeSession, status: "in_progress" });
      const failure = new Error("Native settlement unavailable");
      fixture.cancel.mockRejectedValueOnce(failure);
      const cleanup = () =>
        harness.withSessionDeletion(
          { ...fixture.params.sessionTarget, assertCurrent: () => {} },
          async (settle) => settle(),
        );
      await expect(cleanup()).rejects.toBe(failure);
      expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(saved);
      expect(fixture.events).toEqual([]);
      await cleanup();
      expect(resolveProviderAuth).toHaveBeenCalledTimes(1);
      expect(fixture.events).toEqual(["cancel"]);
      expect((await fixture.openStore().lookup(fixture.params.sessionId)) ?? {}).toEqual({});
    } finally {
      await harness.dispose();
    }
  });
});

it.each(["authority revoked", "oauth credential"] as const)(
  "preserves restarted external session binding on %s before native cleanup",
  async (failureMode) => {
    await withOpenClawTestState({ label: "agentsapi-executor-restart-auth" }, async (state) => {
      const fixture = await externalSessionFixture(state);
      let harness = fixture.createHarness();
      try {
        await harness.runAttempt(fixture.params);
        const saved = await fixture.openStore().lookup(fixture.params.sessionId);
        await harness.dispose();
        await reopenState();
        harness = fixture.createHarness();
        fixture.events.length = 0;
        fixture.session
          .mockClear()
          .mockResolvedValue({ ...fixture.nativeSession, status: "in_progress" });
        const failure = new Error(failureMode);
        let current = true;
        resolveProviderAuth.mockImplementationOnce(async () => {
          await Promise.resolve();
          if (failureMode === "oauth credential") {
            return { apiKey: "fixture-oauth-token", mode: "oauth", source: "fixture" };
          }
          current = false;
          return { apiKey: "fixture-not-a-real-api-key", mode: "api-key", source: "fixture" };
        });
        const cleanup = () =>
          harness.withSessionDeletion(
            {
              ...fixture.params.sessionTarget,
              assertCurrent: () => {
                if (!current) {
                  throw failure;
                }
              },
            },
            async (settle) => settle(),
          );
        if (failureMode === "oauth credential") {
          await expect(cleanup()).rejects.toThrow();
        } else {
          await expect(cleanup()).rejects.toBe(failure);
        }
        expect(resolveProviderAuth).toHaveBeenCalledTimes(1);
        expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(saved);
        expect(fixture.session.mock.calls).toEqual([]);
        expect(fixture.events).toEqual([]);
        current = true;
        await cleanup();
        expect(fixture.events).toEqual(["cancel"]);
        expect(await fixture.openStore().lookup(fixture.params.sessionId)).toBeUndefined();
      } finally {
        await harness.dispose();
      }
    });
  },
);

registerMigrationTests(fetchWithSsrFGuardMock);

function expectText(input: string, fragments: string[]) {
  for (const fragment of fragments) {
    expect(input).toContain(fragment);
  }
}

async function expectForwardingChange(
  result: ReturnType<ReturnType<typeof registerHarness>["runAttempt"]>,
) {
  await expect(result).resolves.toMatchObject({
    terminal: {
      kind: "failed",
      error: expect.objectContaining({
        message: expect.stringContaining("forwarding policy changed; reset the OpenClaw session"),
      }),
    },
  });
}
