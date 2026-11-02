import { createHash } from "node:crypto";
import path from "node:path";
import {
  AgentHarnessPreflightError,
  type AgentHarnessAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import * as harnessRuntime from "openclaw/plugin-sdk/agent-harness-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { Type } from "typebox";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StoredBinding } from "./agentsapi-binding-record.js";
import { AgentsApiClient, type AgentsApiInputFile } from "./agentsapi-client.js";
import {
  createAttempt,
  createBindingStore as migrationStore,
  mockClient,
  registerHarness,
  reopenState,
} from "./agentsapi-harness.persistence.test-helpers.js";
import {
  withNativeFixture,
  withPersistenceFixture,
} from "./agentsapi-persistence-fixture.test-support.js";
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

const nativeTools = ["exec", "process", "read", "write", "edit", "apply_patch", "web_search"];

afterEach(() => {
  clearRuntimeConfigSnapshot();
  createSession.mockReset();
  resetPluginStateStoreForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each([true, false])("sends only enabled forwarding surfaces: %s", async (enabled) => {
  const forwarding = enabled ? undefined : { gatewayTools: false, mcpServers: false };
  await withPersistenceFixture(
    "session-fixture",
    async (client) => {
      const { params } = client;
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
        if (!enabled) {
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
      if (!enabled) {
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
                Authorization: enabled
                  ? "Bearer fixture-token"
                  : "Bearer ${AGENTSAPI_FORWARDING_TEST_MISSING}",
              },
            },
          },
        },
      };
      const run = (runId: string) =>
        client.run({
          config,
          runId,
          // Match the native-only allowlist that does not itself disable MCP forwarding.
          ...(!enabled ? { toolsAllow: nativeTools } : {}),
          hostCapabilities: { ...params.hostCapabilities, createToolSurfaceAsync: construct },
        });
      await run("first-forwarding-run");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        agent: {
          tools: [
            { type: "web_search", mode: "live" },
            { type: "programmatic_tool_calling", enabled: true },
            ...(enabled
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
            ...(enabled ? [{ type: "function", name: "fixture_gateway" }] : []),
          ],
        },
        environment: { type: "openai_hosted", files: [] },
      });
      if (!enabled) {
        config.mcp!.servers!.future = {
          transport: "streamable-http",
          url: "https://future.example.test/mcp",
        };
      }
      await run("followup-forwarding-run");
      expect(requests).toHaveLength(1);
      expect(client.message.mock.calls.map(([id]) => id)).toEqual(Array(2).fill("session-fixture"));
      expect(construct).toHaveBeenCalledTimes(enabled ? 2 : 0);
      expect(loadMcp).toHaveBeenCalledTimes(enabled ? 2 : 0);
    },
    () => ({ plugins: { entries: { agentsapi: { config: { forwarding } } } } }),
  );
});

it("retains immutable forwarding bindings across policy changes and permits explicit reset", async () => {
  let forwarding = { gatewayTools: true, mcpServers: true };
  await withPersistenceFixture(
    "isolated-native-session",
    async (client) => {
      const { params, openStore } = client;
      const original = {
        sessionId: "original-native-session",
        configFingerprint: "7279f68deebd4e52eb136c95ccbb8c642a7f141b836a33de22c8aa9a4a93c022",
      };
      await openStore().register(params.sessionId, original);
      const cancel = vi.spyOn(AgentsApiClient.prototype, "cancel").mockResolvedValue();
      // Explicit defaults must still accept the exact pre-policy persisted identity.
      await client.run();
      for (const restricted of [
        { gatewayTools: false, mcpServers: true },
        { gatewayTools: true, mcpServers: false },
        { gatewayTools: false, mcpServers: false },
      ]) {
        forwarding = restricted;
        await expectForwardingChange(client.harness.runAttempt(params));
        expect(await openStore().lookup(params.sessionId)).toEqual(original);
      }
      expect(client.create).not.toHaveBeenCalled();
      expect(client.update).toHaveBeenCalledTimes(1);
      expect(client.message).toHaveBeenCalledTimes(1);
      // Cleanup must still work after restart, without accepting the new policy for resume.
      await client.restart();
      client.session.mockResolvedValue({
        ...createHostedSession("in_progress"),
        id: original.sessionId,
      });
      await client.harness.reset({ ...params.sessionTarget, reason: "reset" });
      expect(cancel).toHaveBeenCalledExactlyOnceWith(original.sessionId, expect.any(AbortSignal));
      await client.run();
      const isolated = await openStore().lookup(params.sessionId);
      expect(isolated).toMatchObject({ sessionId: "isolated-native-session" });
      expect(isolated?.configFingerprint).not.toBe(original.configFingerprint);
      forwarding = { gatewayTools: true, mcpServers: true };
      await expectForwardingChange(client.harness.runAttempt(params));
      expect(await openStore().lookup(params.sessionId)).toEqual(isolated);
      expect(client.create).toHaveBeenCalledTimes(1);
      expect(client.message).toHaveBeenCalledTimes(2);
    },
    () => ({ plugins: { entries: { agentsapi: { config: { forwarding } } } } }),
  );
});

it("continues inline images with an oversized original and the following turn on the same native session", async () => {
  await withPersistenceFixture("image-session", async ({ create, message, run }) => {
    const original = await saveMediaBuffer(
      Buffer.alloc(5 * 1024 * 1024 + 1, 32),
      "application/pdf",
      "inbound",
      5 * 1024 * 1024 + 1,
      "brief.pdf",
    );
    const prompt = "Summarize the supplied extracted text: the launch window is October.";
    await run({
      prompt,
      media: [{ path: original.path, sizeBytes: 1 }],
      images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
    });
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
    await run({ runId: "following-turn" });
    expect(message.mock.calls.map(([id]) => id)).toEqual(Array(2).fill("image-session"));
    expect(create).toHaveBeenCalledTimes(1);
  });
});

it("skips canonical empty media slots while preserving numbered originals and source validation", async () => {
  await withPersistenceFixture(
    "sparse-session",
    async ({ params, create, message, run, harness }) => {
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
      await run({ hostCapabilities });
      expect(create.mock.calls[0]?.[3]?.files).toEqual([]);
      expect(message.mock.calls[0]?.[1]).toContain(params.prompt);
      expect(message.mock.calls[0]?.[1]).not.toContain("Input attachment feedback:");

      const bytes = Buffer.from("The launch window is October.");
      const saved = await saveMediaBuffer(bytes, "text/plain", "inbound");
      media = [
        ...Array.from({ length: 50 }, () => empty),
        { url: `media://inbound/${saved.id}`, fileName: "brief.txt" },
      ];
      await run({ hostCapabilities, runId: "sparse-file-turn" });
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
          error: {
            message: "Agents API input attachment requires a host-prepared managed media source",
          },
        },
      });
      expect(create).toHaveBeenCalledTimes(1);
      expect(message.mock.calls.map(([id]) => id)).toEqual(Array(2).fill("sparse-session"));
    },
  );
});

it("continues with original attachments on the same hosted session disconnected after a partial upload", async () => {
  await withPersistenceFixture(
    "image-session",
    async ({ params, create, message, session, run }) => {
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
            status: uploadedCount < 1 ? "connected" : "disconnected",
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
      for (const [index, batch] of [[originals[0]!], originals.slice(1)].entries()) {
        const media = await Promise.all(
          batch.map(async (bytes) => {
            const saved = await saveMediaBuffer(bytes, "image/png", "inbound");
            return { url: `media://inbound/${saved.id}`, fileName: "scene.png" };
          }),
        );
        const result = await run({
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
      expect(attemptedFiles).toHaveLength(2);
      expect(uploadedCount).toBe(1);
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
      expect(message.mock.calls.map(([id]) => id)).toEqual(Array(2).fill("image-session"));
      for (const invocation of upload.mock.invocationCallOrder) {
        expect(invocation).toBeLessThan(message.mock.invocationCallOrder[1]!);
      }
    },
  );
});

it("reports unsupported tool restrictions without replacing the bound native session", async () => {
  await withPersistenceFixture(
    "retained-session",
    async ({ params, create, message, harness, run }) => {
      await run();
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

      await run({ runId: "allowed-following-run" });
      expect(create).toHaveBeenCalledTimes(1);
      expect(message.mock.calls.map(([id]) => id)).toEqual(Array(2).fill("retained-session"));
    },
  );
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
    await withNativeFixture(async (fixture) => {
      const saved = {
        sessionId: fixture.nativeSession.id,
        configFingerprint: "saved-config",
        ...(kind !== "ownerless" ? { executorControllerPluginId: "original-controller" } : {}),
        ...(kind !== "owner-only" ? { executor: { sessionKey: fixture.params.sessionKey } } : {}),
      };
      const openRawStore = () => fixture.openStore<Record<string, unknown>>();
      await openRawStore().register(fixture.params.sessionId, saved);
      await fixture.restart();
      const target = fixture.target;
      const commit = vi.fn(async () => {});
      for (const operation of [
        () => fixture.harness.runAttempt(fixture.params),
        () => fixture.harness.reset({ ...target, reason: "reset" }),
        () => fixture.harness.withSessionDeletion(target, commit),
        () => fixture.harness.withSessionContextReset(target, commit),
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
    });
  },
);

it.each(["authority revoked", "oauth credential"] as const)(
  "preserves restarted external session binding on %s before native cleanup",
  async (failureMode) => {
    await withNativeFixture(async (fixture) => {
      await fixture.harness.runAttempt(fixture.params);
      const saved = await fixture.binding();
      await fixture.restart();
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
        fixture.harness.withSessionDeletion(
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
      expect(await fixture.binding()).toEqual(saved);
      expect(fixture.session.mock.calls).toEqual([]);
      expect(fixture.events).toEqual([]);
      current = true;
      await cleanup();
      expect(fixture.events).toEqual(["cancel"]);
      expect(await fixture.binding()).toBeUndefined();
    });
  },
);

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

it.each([
  ["openai_hosted", "delete", true],
  ["self_hosted", "reset", true],
  ["self_hosted", "delete", false],
] as const)(
  "retries %s %s cleanup (restart: %s) without losing history",
  async (environment, operation, restart) => {
    await withNativeFixture(async (fixture) => {
      if (!restart) {
        await fixture.harness.runAttempt(fixture.params);
      }
      const saved = restart
        ? { sessionId: fixture.nativeSession.id, configFingerprint: "saved-config" }
        : await fixture.binding();
      if (restart) {
        await fixture.openStore().register(fixture.params.sessionId, saved!);
        await fixture.restart();
      }
      fixture.events.length = 0;
      fixture.session.mockResolvedValue({
        ...fixture.nativeSession,
        status: "in_progress",
        environment:
          environment === "openai_hosted"
            ? createHostedSession().environment
            : fixture.nativeSession.environment,
      });
      const { agent } = fixture.runtime;
      vi.mocked(agent.resolveAgentDir).mockReturnValue("/gateway/agents/main");
      vi.mocked(agent.resolveAgentWorkspaceDir).mockReturnValue("/gateway/workspace");
      const deleteSession = vi
        .spyOn(AgentsApiClient.prototype, "deleteSession")
        .mockResolvedValue();
      const cleanup = () =>
        operation === "reset"
          ? fixture.harness.reset({ ...fixture.params.sessionTarget, reason: "reset" })
          : fixture.harness.withSessionDeletion(fixture.target, async (settle) => settle());
      const failure = new Error("Native cancellation unavailable");
      fixture.cancel.mockRejectedValueOnce(failure);
      const failed = cleanup();
      await expect(failed).rejects.toThrow(failure.message);
      if (!restart) {
        await expect(failed).rejects.toBe(failure);
      }
      expect(await fixture.binding()).toEqual(saved);
      expect(fixture.events).toEqual([]);
      await cleanup();
      expect((await fixture.binding()) ?? {}).toEqual({});
      expect(fixture.events).toEqual(["cancel"]);
      expect(resolveProviderAuth).toHaveBeenCalledTimes(restart ? 2 : 1);
      expect(resolveProviderAuth).toHaveBeenLastCalledWith(
        expect.objectContaining({
          provider: "openai",
          agentDir: "/gateway/agents/main",
          workspaceDir: "/gateway/workspace",
        }),
      );
      expect(agent.resolveAgentDir).toHaveBeenLastCalledWith(expect.any(Object), "main");
      expect(fixture.cancel).toHaveBeenCalledTimes(2);
      expect(deleteSession).not.toHaveBeenCalled();
    });
  },
);

it.each([
  { outcome: "rollback", predecessor: false },
  { outcome: "reject", predecessor: true },
  { outcome: "commit", predecessor: true },
] as const)(
  "context reset: $outcome (predecessor: $predecessor)",
  async ({ outcome, predecessor }) => {
    await withNativeFixture(async (fixture) => {
      expect(await fixture.harness.runAttempt(fixture.params)).toMatchObject({
        terminal: { kind: "ok" },
      });
      const saved = await fixture.binding();
      const successor = {
        sessionId: "rotated-local-session",
        previousSessionId: fixture.params.sessionId,
      };
      if (predecessor) {
        await patchSessionEntry({
          ...fixture.params.sessionTarget,
          update: () => successor,
        });
      }
      fixture.events.length = 0;
      const failure = new Error("History cut rejected");
      const result = fixture.harness.withSessionContextReset(
        {
          ...fixture.target,
          ...(predecessor ? successor : {}),
        },
        async (settle) => {
          if (outcome === "reject") {
            throw failure;
          }
          await settle(outcome);
          fixture.events.push(outcome);
        },
      );
      if (outcome === "reject") {
        await expect(result).rejects.toBe(failure);
      } else {
        await result;
      }
      expect(await fixture.binding()).toEqual(outcome === "commit" ? undefined : saved);
      expect(fixture.events).toEqual(
        outcome === "commit" ? ["commit"] : outcome === "rollback" ? ["rollback"] : [],
      );
    });
  },
);

const legacy = {
  sessionId: "stable-native-session",
  authFingerprint: "3c26b68488ce497a69d2c9fce9ee19c461fa67a3d959b0dc3bafe5718c56119d",
};
const legacySession = () => ({ ...createHostedSession(), id: legacy.sessionId });

function guardedResponse(finalUrl: string, response: Response) {
  return { finalUrl, response, release: async () => {} };
}

function pluginConfig(config: Record<string, unknown>): OpenClawConfig {
  return { plugins: { entries: { agentsapi: { config } } } };
}

type MigrationFixture<T> = {
  params: Awaited<ReturnType<typeof createAttempt>>;
  store: ReturnType<typeof migrationStore<T>>;
  client: ReturnType<typeof mockClient>;
  harness: ReturnType<typeof registerHarness>;
  config: { current: OpenClawConfig };
};

function withMigration<T = StoredBinding>(
  run: (fixture: MigrationFixture<T>) => Promise<void>,
  initialConfig: OpenClawConfig = {},
) {
  const config = { current: initialConfig };
  return withPersistenceFixture(
    "must-not-create",
    (client) =>
      run({
        params: client.params,
        store: client.openStore<T>(),
        client,
        harness: client.harness,
        config,
      }),
    () => config.current,
  );
}

function expectNoCalls(...mocks: unknown[]) {
  mocks.forEach((mock) => expect(mock).not.toHaveBeenCalled());
}

// v2026.9.9 stores the hash of [model.id, resolvedApiKey], not configFingerprint.
it("upgrades a v2026.9.9 hosted binding without replacing its remote session", () =>
  withOpenClawTestState({ label: "agentsapi-stable-upgrade" }, async (state) => {
    const params = await createAttempt(state.stateDir);
    const openStore = () => migrationStore<unknown>(state.env);
    await openStore().register(params.sessionId, legacy);
    const { create, message, session } = mockClient("must-not-create");
    session.mockResolvedValue(legacySession());
    const canonical = {
      sessionId: legacy.sessionId,
      configFingerprint: "7279f68deebd4e52eb136c95ccbb8c642a7f141b836a33de22c8aa9a4a93c022",
    };
    for (const resolvedApiKey of [params.resolvedApiKey, "fixture-rotated-key"]) {
      await reopenState();
      const harness = registerHarness(state.env);
      try {
        expect(await harness.runAttempt({ ...params, resolvedApiKey })).toMatchObject({
          terminal: { kind: "ok" },
        });
        expect(await openStore().lookup(params.sessionId)).toEqual(canonical);
      } finally {
        await harness.dispose();
      }
    }
    expect(create).not.toHaveBeenCalled();
    expect(message.mock.calls.map(([id]) => id)).toEqual([legacy.sessionId, legacy.sessionId]);
  }));

it("retains legacy state rather than guessing after credential or immutable policy changes", () =>
  withMigration(async ({ params, store, client, harness, config }) => {
    await store.register(params.sessionId, legacy);
    const changed = { transport: "streamable-http" as const, url: "https://mcp.example.test" };
    const cases: Array<[string, Partial<AgentHarnessAttemptParamsV2>, OpenClawConfig?]> = [
      ["rotated key", { resolvedApiKey: "fixture-rotated-key" }],
      ["model", { model: { ...params.model, id: "different-model" } }],
      ["environment", {}, pluginConfig({ environment: "self_hosted" })],
      ["network", {}, pluginConfig({ openai_host: { network: { access: "disabled" } } })],
      ["MCP", { config: { mcp: { servers: { changed } } } }],
      ["native search", { toolOverrides: { webSearch: false } }],
      ["Gateway forwarding", {}, pluginConfig({ forwarding: { gatewayTools: false } })],
      ["MCP forwarding", {}, pluginConfig({ forwarding: { mcpServers: false } })],
    ];
    for (const [name, overrides, nextConfig] of cases) {
      config.current = nextConfig ?? {};
      await expect(harness.runAttempt({ ...params, ...overrides })).rejects.toThrow(
        "restore the original configuration and API key",
      );
      expect(await store.lookup(params.sessionId), name).toEqual(legacy);
    }
    expectNoCalls(client.session, client.create, client.update, client.message);
  }));

it("retains corrupt and partial binding rows before either resume or cleanup", () =>
  withMigration<unknown>(async ({ params, client, harness, store }) => {
    for (const row of [
      { sessionId: legacy.sessionId },
      { authFingerprint: legacy.authFingerprint },
      { ...legacy, configFingerprint: "ambiguous" },
      { ...legacy, authFingerprint: "not-a-digest" },
      { ...legacy, lease: { token: "incomplete" } },
      { ...legacy, unknown: "must-not-strip" },
    ]) {
      await store.register(params.sessionId, row);
      await expect(harness.runAttempt(params)).rejects.toThrow("Invalid Agents API binding row");
      await expect(harness.reset({ ...params.sessionTarget, reason: "reset" })).rejects.toThrow(
        "Invalid Agents API binding row",
      );
      expect(await store.lookup(params.sessionId)).toEqual(row);
    }
    expectNoCalls(client.session, client.create, client.message);
  }));

it("checks current-key SDK access before upgrading and retains failed admission for retry", () =>
  withMigration(async ({ params, store, client, harness }) => {
    await store.register(params.sessionId, legacy);
    client.session.mockRestore();
    const error = { error: { message: "fixture access refused", type: "invalid_request_error" } };
    for (const status of [401, 403, 404, 500]) {
      fetchWithSsrFGuardMock.mockImplementationOnce(async ({ url, init }) => {
        expect(url).toBe("https://api.openai.com/v1/agents/sessions/" + legacy.sessionId);
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer " + params.resolvedApiKey,
        );
        return guardedResponse(url, Response.json(error, { status }));
      });
      await expect(harness.runAttempt(params)).rejects.toThrow("fixture access refused");
      expect(await store.lookup(params.sessionId)).toEqual(legacy);
    }
    fetchWithSsrFGuardMock.mockImplementationOnce(async () => {
      throw new TypeError("fixture transport unavailable");
    });
    await expect(harness.runAttempt(params)).rejects.toThrow();
    expect(await store.lookup(params.sessionId)).toEqual(legacy);
    expectNoCalls(client.create, client.update, client.message);
    fetchWithSsrFGuardMock.mockImplementationOnce(async ({ url }) =>
      guardedResponse(url, Response.json({ ...legacySession(), id: "different-session" })),
    );
    await expect(harness.runAttempt(params)).rejects.toThrow("different session");
    expect(await store.lookup(params.sessionId)).toEqual(legacy);
    fetchWithSsrFGuardMock.mockImplementationOnce(async ({ url }) =>
      guardedResponse(url, Response.json(legacySession())),
    );
    expect(await harness.runAttempt(params)).toMatchObject({ terminal: { kind: "ok" } });
    expect(await store.lookup(params.sessionId)).toMatchObject({
      sessionId: legacy.sessionId,
      configFingerprint: expect.any(String),
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(7);
  }));

it("fences legacy migration when generation, lease, or source changes during access validation", () =>
  withMigration(async ({ params, store, client, harness }) => {
    let active = true;
    params.hostCapabilities.assertActive = () => {
      if (!active) {
        throw new Error("fixture authority revoked");
      }
    };
    try {
      const changes: Array<[string, StoredBinding, string]> = [
        ["authority", legacy, "fixture authority revoked"],
        [
          "lease",
          { ...legacy, lease: { token: "successor", expiresAt: Date.now() + 65_000 } },
          "lease lost",
        ],
        ["source", { ...legacy, authFingerprint: "a".repeat(64) }, "changed during migration"],
      ];
      for (const [change, expected, error] of changes) {
        active = true;
        await store.register(params.sessionId, legacy);
        client.session.mockImplementationOnce(async () => {
          const current = (await store.lookup(params.sessionId))!;
          active = change !== "authority";
          if (active) {
            await store.register(params.sessionId, {
              ...expected,
              lease: expected.lease ?? current.lease,
            });
          }
          return legacySession();
        });
        await expect(harness.runAttempt(params)).rejects.toThrow(error);
        expect(await store.lookup(params.sessionId)).toEqual(expected);
      }
      expectNoCalls(client.create, client.update, client.message);
    } finally {
      active = true;
    }
  }));

it("resumes a shipped self-hosted binding with an expired lease without adopting an executor owner", () =>
  withMigration(
    async ({ params, store, client, harness }) => {
      // Exact v2026.9.9 producer identity, with its workspace-dependent environment.
      const environment = { type: "self_hosted", workspace_directory: params.workspaceDir };
      const row = {
        sessionId: legacy.sessionId,
        authFingerprint: createHash("sha256")
          .update(JSON.stringify([params.model.id, params.resolvedApiKey, environment]))
          .digest("hex"),
      };
      await store.register(params.sessionId, {
        ...row,
        lease: { token: "expired-owner", expiresAt: Date.now() - 1 },
      });
      client.session.mockResolvedValue(legacySession());
      expect(await harness.runAttempt(params)).toMatchObject({ terminal: { kind: "ok" } });
      const saved = await store.lookup(params.sessionId);
      expect(saved).toEqual({ sessionId: row.sessionId, configFingerprint: expect.any(String) });
      expect(saved?.configFingerprint).not.toBe(row.authFingerprint);
      expect(client.create).not.toHaveBeenCalled();
    },
    pluginConfig({ environment: "self_hosted" }),
  ));

it.each(["reset", "delete", "context rollback"] as const)(
  "settles unmigratable legacy work before %s with current agent authentication",
  (operation) =>
    withNativeFixture(async (fixture) => {
      const { params, target } = fixture;
      const store = fixture.openStore<StoredBinding>();
      await store.register(params.sessionId, legacy);
      await fixture.restart();
      fixture.session.mockResolvedValue({
        ...fixture.nativeSession,
        id: legacy.sessionId,
        status: "in_progress",
      });
      const successor = {
        sessionId: "successor-local-session",
        previousSessionId: params.sessionId,
      };
      if (operation === "context rollback") {
        await patchSessionEntry({ ...params.sessionTarget, update: () => successor });
      }
      const cleanup = () =>
        operation === "reset"
          ? fixture.harness.reset({ ...target, reason: "reset" })
          : operation === "delete"
            ? fixture.harness.withSessionDeletion(target, async (settle) => settle())
            : fixture.harness.withSessionContextReset({ ...target, ...successor }, (settle) =>
                settle("rollback"),
              );
      fixture.cancel.mockRejectedValueOnce(new Error("fixture settlement unavailable"));
      await expect(cleanup()).rejects.toThrow("fixture settlement unavailable");
      expect(await store.lookup(params.sessionId)).toEqual(legacy);
      await cleanup();
      expect((await store.lookup(params.sessionId)) ?? {}).toEqual(
        operation === "context rollback" ? legacy : {},
      );
      expect(fixture.cancel.mock.calls.map(([id]) => id)).toEqual([
        legacy.sessionId,
        legacy.sessionId,
      ]);
      expectNoCalls(fixture.create);
    }),
);
