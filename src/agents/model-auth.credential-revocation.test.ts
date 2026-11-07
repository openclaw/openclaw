import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import { afterEach, expect, it, vi } from "vitest";
import { bindModelLlmRuntime } from "../llm/model-runtime-binding.js";
import * as rateLimits from "../llm/provider-rate-limit.js";
import { complete } from "../llm/stream.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import {
  attachProviderAuthAuthority,
  getProviderAuthAuthority,
  assertProviderAuthAuthority,
} from "../plugins/provider-auth-authority.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import {
  loadAuthProfileStoreForRuntimeAsync,
  updateAuthProfileStoreWithLock,
} from "./auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "./auth-profiles/types.js";
import { resolveApiKeyForProviderCore } from "./model-auth.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const provider = "revocation-fixture";
const profileId = `${provider}:selected`;
const options = { filterExternalAuthProfiles: false, syncExternalCli: false };
const credential = (type: "api_key" | "token", value: string): AuthProfileCredential =>
  type === "api_key" ? { type, provider, key: value } : { type, provider, token: value };
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
});
const save = (agentDir: string, profiles: Record<string, AuthProfileCredential>) =>
  updateAuthProfileStoreWithLock({
    agentDir,
    saveOptions: options,
    updater(store) {
      store.profiles = profiles;
      return true;
    },
  });

it.each(
  (["api_key", "token"] as const).flatMap((type) =>
    [false, true].map((inherited) => ({ type, inherited })),
  ),
)(
  "rejects a retained $type profile after its real owner removes it (inherited: $inherited)",
  async ({ type, inherited }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const ownerDir = state.agentDir();
      const agentDir = inherited ? state.agentDir("consumer") : ownerDir;
      await save(ownerDir, { [profileId]: credential(type, "old") });
      const store = await loadAuthProfileStoreForRuntimeAsync(agentDir, {
        readOnly: true,
        externalCli: { mode: "none" },
      });
      const resolve = () =>
        resolveApiKeyForProviderCore({ provider, profileId, store, agentDir, cfg: {} });
      const prepared = await resolve();
      expect(prepared.apiKey).toBe("old");
      assertProviderAuthAuthority(prepared);
      await save(ownerDir, {
        [profileId]: credential(type, "old"),
        unrelated: credential(type, "other"),
      });
      assertProviderAuthAuthority(prepared);
      const registry = createApiRegistry();
      const target = makeProviderModelFixture({
        api: "revocation-fixture",
        provider,
        id: "vision",
        baseUrl: "https://example.invalid",
      });
      const message = makeAgentAssistantMessage({ content: [{ type: "text", text: "control" }] });
      const dispatch = vi.fn(() => {
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
        return stream;
      });
      registry.registerApiProvider({ api: target.api, stream: dispatch, streamSimple: dispatch });
      const model = bindModelLlmRuntime(
        attachProviderAuthAuthority(target, getProviderAuthAuthority(prepared)),
        createLlmRuntime(registry),
      );
      await expect(complete(model, { messages: [] }, { apiKey: prepared.apiKey })).resolves.toEqual(
        message,
      );
      expect(dispatch).toHaveBeenCalledTimes(1);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const admit = rateLimits.createProviderRateLimitRequest;
      vi.spyOn(rateLimits, "createProviderRateLimitRequest").mockImplementation((...args) => {
        const admission = admit(...args);
        return {
          ...admission,
          async wait(...waitArgs) {
            entered.resolve();
            await release.promise;
            return admission.wait(...waitArgs);
          },
        };
      });
      const pending = complete(model, { messages: [] }, { apiKey: prepared.apiKey });
      const refused = expect(pending).rejects.toThrow(/removed|replaced/);
      await entered.promise;
      await save(ownerDir, {});
      release.resolve();
      await refused;
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(() => assertProviderAuthAuthority(prepared)).toThrow(/removed|replaced/);
      await expect(resolve()).rejects.toThrow();
    });
  },
);

it("keeps current profile replacement separate from retained credential authority", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentDir = state.agentDir();
    const replace = (key: string) => save(agentDir, { [profileId]: credential("api_key", key) });
    await replace("old");
    const store = await loadAuthProfileStoreForRuntimeAsync(agentDir, {
      readOnly: true,
      externalCli: { mode: "none" },
    });
    const cfg = {
      models: {
        providers: {
          [provider]: {
            api: "openai-completions" as const,
            baseUrl: "http://127.0.0.1:1",
            apiKey: profileId,
            models: [],
          },
        },
      },
    };
    const resolve = (selected = store) =>
      resolveApiKeyForProviderCore({ provider, store: selected, agentDir, cfg });
    const prepared = await resolve();
    expect(prepared.apiKey).toBe("old");
    await replace("replacement");
    expect(() => assertProviderAuthAuthority(prepared)).toThrow(/removed|replaced/);
    await expect(resolve()).rejects.toThrow();
    const current = await resolve(
      await loadAuthProfileStoreForRuntimeAsync(agentDir, {
        readOnly: true,
        externalCli: { mode: "none" },
      }),
    );
    expect(current.apiKey).toBe("replacement");
    assertProviderAuthAuthority(current);
  });
});
