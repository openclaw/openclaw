import path from "node:path";
import { patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { expect, it } from "vitest";
import { ownCodexInferenceClient } from "./inference-routing.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import {
  createFakeClient,
  getSharedCodexAppServerClientMock,
  platformPreparedRuntimeAuth,
  runCodexAppServerSideQuestion,
  sideParams,
  runCodexAppServerSideQuestionImpl,
} from "./side-question.test-support.js";
export function registerSideQuestionStartupAuthorityTests(tempDirs: { make: () => string }) {
  it.each(["matching", "mismatched", "retired"] as const)(
    "binds a hosted side fork only to its prepared endpoint (%s)",
    async (variant) => {
      const baseUrl = "https://hosted.example.com/v1";
      const client = createFakeClient();
      const originalRequest = client.request.getMockImplementation()!;
      client.request.mockImplementation(async (method, params, options) => {
        if (method === "config/read") {
          return {
            config: {
              openai_base_url:
                variant === "mismatched" ? "https://different.example.com/v1" : baseUrl,
            },
            origins: {},
            layers: [],
          };
        }
        if (method === "account/read") {
          return { account: { type: "apiKey" } };
        }
        const result = await originalRequest(method, params, options);
        if (method === "thread/fork" && variant === "retired") {
          client.emit({ method: "account/updated", params: { authMode: "chatgpt" } });
        }
        return result;
      });
      ownCodexInferenceClient(client);
      getSharedCodexAppServerClientMock.mockResolvedValue(client);
      const preparedRuntimeAuth = platformPreparedRuntimeAuth("test-hosted-key");
      const pending = runCodexAppServerSideQuestion(
        sideParams({
          authProfileId: undefined,
          preparedRuntimeAuth: {
            ...preparedRuntimeAuth,
            plan: {
              ...preparedRuntimeAuth.plan,
              modelRoute: {
                ...preparedRuntimeAuth.plan.modelRoute,
                baseUrl,
                runtimePolicy: {
                  compatibleIds: ["openclaw", "codex"],
                  requiresEndpointBinding: true,
                },
              },
            },
          },
        }),
      );
      try {
        if (variant === "matching") {
          await expect(pending).resolves.toMatchObject({ text: "Side answer." });
          expect(client.request).toHaveBeenCalledWith(
            "thread/fork",
            expect.objectContaining({
              config: expect.objectContaining({ openai_base_url: baseUrl }),
            }),
            expect.anything(),
          );
        } else {
          await expect(pending).rejects.toThrow(
            "Codex cannot bind the exact prepared provider endpoint",
          );
          expect(client.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
          if (variant === "mismatched") {
            expect(client.request.mock.calls.some(([method]) => method === "thread/fork")).toBe(
              false,
            );
          }
        }
      } finally {
        client.close();
      }
    },
  );

  it("fences a recovered predecessor when its host rotates before the fork", async () => {
    const root = tempDirs.make();
    const storePath = path.join(root, "admitted", "sessions.json");
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionKey: "agent:main:side-continuity",
      sessionId: "before-compaction",
    };
    const current = { ...previous, sessionId: "after-compaction" };
    const scope = { agentId: previous.agentId, sessionKey: previous.sessionKey, storePath };
    await upsertSessionEntry({
      ...scope,
      entry: { sessionId: previous.sessionId, updatedAt: 1 },
    });
    const sessionEntry = await patchSessionEntry({
      ...scope,
      update: () => ({ sessionId: current.sessionId }),
    });
    if (!sessionEntry) {
      throw new Error("Expected the committed successor session");
    }
    const parent = { threadId: "parent-thread", cwd: "/tmp/workspace" };
    const persistedBindings = createCodexTestBindingStore();
    await persistedBindings.mutate(previous, { kind: "set", binding: parent });
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockImplementationOnce(async () => {
      expect(persistedBindings.read(current)).toEqual(parent);
      await patchSessionEntry({ ...scope, update: () => ({ sessionId: "next-compaction" }) });
      return client;
    });

    const operation = runCodexAppServerSideQuestionImpl(
      sideParams({
        cfg: { session: { store: path.join(root, "configured", "sessions.json") } },
        storePath,
        agentId: current.agentId,
        sessionKey: current.sessionKey,
        sessionId: current.sessionId,
        sessionEntry,
      }),
      { bindingStore: persistedBindings },
    );
    await expect(operation).rejects.toThrow("Codex session generation is no longer current");
    expect(client.request.mock.calls.some(([method]) => method === "thread/fork")).toBe(false);
    expect(persistedBindings.read(current)).toEqual(parent);
  });
}
