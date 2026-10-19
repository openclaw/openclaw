import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginStateRuntimeStoresForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import * as authRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  jsonResponse,
  mockPinnedHostnameResolution,
  requestUrl,
} from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  resetPluginStateStoreForTests();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture(
  research?: Record<string, unknown>,
  sharedDirectory?: string,
  afterBindingLookup?: () => void,
  beforeBindingLookup?: () => void,
) {
  const directory =
    sharedDirectory ?? (await mkdtemp(path.join(tmpdir(), "google-research-owner-")));
  if (!sharedDirectory) {
    directories.push(directory);
  }
  const lifetime = new AbortController();
  const runtime = createPluginRuntimeMock();
  const state = createPluginStateRuntimeStoresForTests("google", () =>
    lifetime.signal.throwIfAborted(),
  );
  runtime.state.openKeyedStoreV2 = <T>(
    options: Parameters<typeof runtime.state.openKeyedStoreV2>[0],
    authority: Parameters<typeof runtime.state.openKeyedStoreV2>[1] = { assertCurrent() {} },
  ) => {
    const store = state.openKeyedStoreV2<T>(
      { ...options, env: { OPENCLAW_STATE_DIR: directory } },
      authority,
    );
    return {
      ...store,
      lookup: async (key) => {
        beforeBindingLookup?.();
        const value = await store.lookup(key);
        afterBindingLookup?.();
        return value;
      },
    };
  };
  const register = vi.fn<OpenClawPluginApi["registerGatewayMethod"]>();
  const api = createTestPluginApi({
    id: "google",
    runtime,
    pluginConfig: research ? { research } : {},
    registerGatewayMethod: register,
  });
  plugin.register(api);
  const registration = register.mock.calls.find(([method]) => method === "google.research.v1");
  if (!registration) {
    throw new Error("Research method not registered");
  }
  const current = vi.fn();
  const signal = new AbortController().signal;
  const borrow = () => ({ signal, assertCurrent: current, release() {} });
  const authority = {
    target: {
      sessionKey: "agent:main:research-fixture",
      agentId: "main",
      sessionId: "generation-1",
    },
    sandboxRequired: false,
    assertCurrent: current,
    retain: borrow,
    retainSession: borrow,
    release() {},
  };
  return {
    api,
    current,
    authority,
    directory,
    async dispose() {
      lifetime.abort(new Error("Provider retired"));
    },
    policy: registration[2],
    async request(request: unknown) {
      const respond = vi.fn();
      // The host prepares authority; this fixture exercises the registered plugin boundary.
      await registration[1]({
        req: { type: "req", id: "research-fixture", method: "google.research.v1" },
        client: null,
        isWebchatConnect: () => false,
        get context(): GatewayRequestHandlerOptions["context"] {
          throw new Error("Research adapter unexpectedly accessed raw Gateway context");
        },
        params: { sessionKey: authority.target.sessionKey, agentId: "main", request },
        sessionAccessAuthority: authority,
        assertHandlerCurrent: () => lifetime.signal.throwIfAborted(),
        signal,
        respond,
      });
      return respond.mock.calls[0]?.[1];
    },
  };
}

describe("registered Google managed-research RPC", () => {
  it("requires explicit activation and rejects unsupported versions before auth or HTTP", async () => {
    const auth = vi.spyOn(authRuntime, "resolveApiKeyForProvider");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const config of [
      undefined,
      { enabled: false, profileId: "google:research" },
      { enabled: true },
    ]) {
      const entry = await fixture(config);
      expect(await entry.request({ version: 1, action: "describe" })).toMatchObject({
        ok: false,
        state: "blocked",
      });
    }
    const entry = await fixture({ enabled: true, profileId: "google:research" });
    expect(entry.policy).toMatchObject({
      profileAccess: "required",
      sessionAccess: { mode: "write", requiredTool: "deep_research", allowOwnSessionScope: true },
    });
    expect(await entry.request({ version: 2, action: "start", question: "River" })).toMatchObject({
      ok: false,
    });
    expect(await entry.request({ version: 1, action: "describe" })).toMatchObject({
      ok: true,
      value: { kind: "managed-research", authModes: ["api-key"] },
    });
    expect(auth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("routes an activated versioned request through the real provider adapter", async () => {
    mockPinnedHostnameResolution();
    const auth = vi.spyOn(authRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      mode: "api-key",
      apiKey: "synthetic-google-key",
      profileId: "google:research",
      source: "profile",
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        id: "research-fixture",
        status: "completed",
        steps: [
          { type: "model_output", content: [{ type: "text", text: "The provider report." }] },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const entry = await fixture({ enabled: true, profileId: "google:research" });
    expect(
      await entry.request({ version: 1, action: "start", question: "Research the river." }),
    ).toMatchObject({
      version: 1,
      ok: true,
      value: {
        state: "completed",
        report: "The provider report.",
        handle: { interactionId: "research-fixture", profileId: "google:research" },
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(auth).toHaveBeenCalledTimes(1);
    expect(
      await entry.request({
        version: 1,
        action: "poll",
        handle: { interactionId: "research-fixture", profileId: "google:another" },
      }),
    ).toMatchObject({ ok: false, state: "blocked" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not publish a report after authority is revoked during the provider request", async () => {
    mockPinnedHostnameResolution();
    vi.spyOn(authRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      mode: "api-key",
      apiKey: "synthetic-google-key",
      profileId: "google:research",
      source: "profile",
    });
    const entry = await fixture({ enabled: true, profileId: "google:research" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        entry.current.mockImplementation(() => {
          throw new Error("retired");
        });
        return jsonResponse({
          id: "research-fixture",
          status: "completed",
          steps: [{ type: "model_output", content: [{ type: "text", text: "Do not publish." }] }],
        });
      }),
    );
    const response = await entry.request({ version: 1, action: "start", question: "River" });
    expect(response).toMatchObject({
      ok: false,
      state: "indeterminate",
      handle: { interactionId: "research-fixture", profileId: "google:research" },
    });
    expect(JSON.stringify(response)).not.toContain("Do not publish.");
  });
  it.each(["poll", "cancel"] as const)(
    "keeps a known %s retryable when the provider fence fails at entry",
    async (action) => {
      mockPinnedHostnameResolution();
      vi.spyOn(authRuntime, "resolveApiKeyForProvider").mockResolvedValue({
        mode: "api-key",
        apiKey: "synthetic-google-key",
        profileId: "google:research",
        source: "profile",
      });
      const fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({ id: "known-interaction", status: "in_progress" }));
      vi.stubGlobal("fetch", fetch);
      const entry = await fixture({ enabled: true, profileId: "google:research" });
      expect(await entry.request({ version: 1, action: "start", question: "River" })).toMatchObject(
        { ok: true },
      );
      await entry.dispose();
      const handle = { interactionId: "known-interaction", profileId: "google:research" };
      expect(await entry.request({ version: 1, action, handle })).toMatchObject({
        ok: false,
        state: "indeterminate",
        handle,
        retryAfterMs: 5000,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a transient pre-HTTP start refusal retryable without a receipt", async () => {
    const entry = await fixture({ enabled: true, profileId: "google:research" });
    vi.spyOn(authRuntime, "resolveApiKeyForProvider").mockImplementationOnce(async () => {
      entry.current.mockImplementation(() => {
        throw Object.assign(new Error("Session access is refreshing"), {
          name: "SessionMutationAuthorizationChangedError",
          error: {
            code: "UNAVAILABLE",
            retryable: true,
            details: { code: "SESSION_ACCESS_REFRESHING" },
          },
        });
      });
      return {
        mode: "api-key",
        apiKey: "synthetic-google-key",
        profileId: "google:research",
        source: "profile",
      };
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const reply = await entry.request({ version: 1, action: "start", question: "River" });
    expect(reply).toMatchObject({ ok: false, state: "blocked", retryAfterMs: 5000 });
    expect(reply).not.toHaveProperty("handle");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["poll", "cancel"] as const)(
    "keeps a known %s retryable when membership refreshes during credential preparation",
    async (action) => {
      mockPinnedHostnameResolution();
      const auth = {
        mode: "api-key" as const,
        apiKey: "synthetic-google-key",
        profileId: "google:research",
        source: "profile",
      };
      const resolve = vi.spyOn(authRuntime, "resolveApiKeyForProvider").mockResolvedValue(auth);
      const fetch = vi
        .fn()
        .mockImplementation(async () =>
          jsonResponse({ id: "prepared-interaction", status: "in_progress" }),
        );
      vi.stubGlobal("fetch", fetch);
      const entry = await fixture({ enabled: true, profileId: "google:research" });
      expect(await entry.request({ version: 1, action: "start", question: "River" })).toMatchObject(
        { ok: true },
      );
      resolve.mockImplementationOnce(async () => {
        entry.current.mockImplementationOnce(() => {
          throw Object.assign(new Error("Session access is refreshing"), {
            name: "SessionMutationAuthorizationChangedError",
            error: {
              code: "UNAVAILABLE",
              retryable: true,
              details: { code: "SESSION_ACCESS_REFRESHING" },
            },
          });
        });
        return auth;
      });
      const handle = { interactionId: "prepared-interaction", profileId: "google:research" };
      expect(await entry.request({ version: 1, action, handle })).toMatchObject({
        ok: false,
        state: "indeterminate",
        handle,
        retryAfterMs: 5000,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await entry.request({ version: 1, action: "poll", handle })).toMatchObject({
        ok: true,
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["poll", "cancel"] as const)(
    "does not retry a known %s after permanent session revocation during HTTP",
    async (action) => {
      mockPinnedHostnameResolution();
      vi.spyOn(authRuntime, "resolveApiKeyForProvider").mockResolvedValue({
        mode: "api-key",
        apiKey: "synthetic-google-key",
        profileId: "google:research",
        source: "profile",
      });
      const fetch = vi
        .fn()
        .mockImplementation(async () =>
          jsonResponse({ id: "revoked-interaction", status: "in_progress" }),
        );
      vi.stubGlobal("fetch", fetch);
      const entry = await fixture({ enabled: true, profileId: "google:research" });
      expect(await entry.request({ version: 1, action: "start", question: "River" })).toMatchObject(
        { ok: true },
      );
      fetch.mockImplementationOnce(async () => {
        entry.current.mockImplementation(() => {
          throw new Error("Session deleted");
        });
        return jsonResponse({
          id: "revoked-interaction",
          status: "completed",
          steps: [
            {
              type: "model_output",
              content: [{ type: "text", text: "Revoked report must not publish." }],
            },
          ],
        });
      });
      const handle = { interactionId: "revoked-interaction", profileId: "google:research" };
      const response = await entry.request({ version: 1, action, handle });
      expect(response).toMatchObject({ ok: false, state: "blocked", handle });
      expect(response).not.toHaveProperty("retryAfterMs");
      expect(JSON.stringify(response)).not.toContain("Revoked report must not publish.");
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["poll", "cancel"] as const)(
    "keeps a known %s retryable after provider retirement during HTTP",
    async (action) => {
      mockPinnedHostnameResolution();
      vi.spyOn(authRuntime, "resolveApiKeyForProvider").mockResolvedValue({
        mode: "api-key",
        apiKey: "synthetic-google-key",
        profileId: "google:research",
        source: "profile",
      });
      const fetch = vi
        .fn()
        .mockImplementation(async () =>
          jsonResponse({ id: "revoked-interaction", status: "in_progress" }),
        );
      vi.stubGlobal("fetch", fetch);
      const entry = await fixture({ enabled: true, profileId: "google:research" });
      expect(await entry.request({ version: 1, action: "start", question: "River" })).toMatchObject(
        { ok: true },
      );
      fetch.mockImplementationOnce(async () => {
        await entry.dispose();
        return jsonResponse({
          id: "revoked-interaction",
          status: "completed",
          steps: [
            {
              type: "model_output",
              content: [{ type: "text", text: "Revoked report must not publish." }],
            },
          ],
        });
      });
      const handle = { interactionId: "revoked-interaction", profileId: "google:research" };
      const response = await entry.request({ version: 1, action, handle });
      expect(response).toMatchObject({
        ok: false,
        state: "indeterminate",
        handle,
        retryAfterMs: 5000,
      });

      expect(JSON.stringify(response)).not.toContain("Revoked report must not publish.");
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["poll", "cancel"] as const)(
    "keeps a known %s retryable after provider retirement at the binding lookup boundary",
    async (action) => {
      mockPinnedHostnameResolution();
      vi.spyOn(authRuntime, "resolveApiKeyForProvider").mockResolvedValue({
        mode: "api-key",
        apiKey: "synthetic-google-key",
        profileId: "google:research",
        source: "profile",
      });
      const fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({ id: "lookup-retirement", status: "in_progress" }));
      vi.stubGlobal("fetch", fetch);
      const entry = await fixture(
        { enabled: true, profileId: "google:research" },
        undefined,
        undefined,
        () => {
          void entry.dispose();
        },
      );
      expect(await entry.request({ version: 1, action: "start", question: "River" })).toMatchObject(
        { ok: true },
      );
      const handle = { interactionId: "lookup-retirement", profileId: "google:research" };
      expect(await entry.request({ version: 1, action, handle })).toMatchObject({
        ok: false,
        state: "indeterminate",
        handle,
        retryAfterMs: 5000,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves the receipt when session membership is refreshing after acceptance", async () => {
    mockPinnedHostnameResolution();
    vi.spyOn(authRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      mode: "api-key",
      apiKey: "synthetic-google-key",
      profileId: "google:research",
      source: "profile",
    });
    const entry = await fixture({ enabled: true, profileId: "google:research" });
    const fetch = vi.fn().mockImplementation(async () => {
      entry.current.mockImplementationOnce(() => {
        throw Object.assign(new Error("Session access is refreshing"), {
          name: "SessionMutationAuthorizationChangedError",
          error: {
            code: "UNAVAILABLE",
            retryable: true,
            details: { code: "SESSION_ACCESS_REFRESHING" },
          },
        });
      });
      return jsonResponse({ id: "research-fixture", status: "in_progress" });
    });
    vi.stubGlobal("fetch", fetch);
    expect(await entry.request({ version: 1, action: "start", question: "River" })).toMatchObject({
      ok: false,
      state: "indeterminate",
      handle: { interactionId: "research-fixture", profileId: "google:research" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockImplementation(async () =>
      jsonResponse({ id: "research-fixture", status: "in_progress" }),
    );
    expect(
      await entry.request({
        version: 1,
        action: "poll",
        handle: { interactionId: "research-fixture", profileId: "google:research" },
      }),
    ).toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("native interaction ownership at the registered RPC", () => {
  it("rejects foreign sessions and reset/deleted generations before read or cancel, but resumes the same owner after restart", async () => {
    mockPinnedHostnameResolution();
    vi.spyOn(authRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      mode: "api-key",
      apiKey: "synthetic-google-key",
      profileId: "google:research",
      source: "profile",
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        jsonResponse({ id: "bound-interaction", status: "in_progress" }),
      );
    vi.stubGlobal("fetch", fetch);
    const config = { enabled: true, profileId: "google:research" };
    const owner = await fixture(config);
    expect(await owner.request({ version: 1, action: "start", question: "River" })).toMatchObject({
      ok: true,
    });
    const handle = { interactionId: "bound-interaction", profileId: "google:research" };
    const other = await fixture(config, owner.directory);
    other.authority.target.sessionKey = "agent:main:another-session";
    expect(await other.request({ version: 1, action: "poll", handle })).toMatchObject({
      ok: false,
      state: "blocked",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    other.authority.target.sessionKey = owner.authority.target.sessionKey;
    other.authority.target.sessionId = "generation-after-reset";
    expect(await other.request({ version: 1, action: "cancel", handle })).toMatchObject({
      ok: false,
      state: "blocked",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const restarted = await fixture(config, owner.directory);
    expect(await restarted.request({ version: 1, action: "poll", handle })).toMatchObject({
      ok: true,
      value: { state: "running" },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    restarted.current.mockImplementation(() => {
      throw new Error("session deleted");
    });
    expect(await restarted.request({ version: 1, action: "cancel", handle })).toMatchObject({
      ok: false,
      state: "blocked",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

it("keeps the selected profile/account fixed and fences late completion after provider reload", async () => {
  mockPinnedHostnameResolution();
  const auth = vi.spyOn(authRuntime, "resolveApiKeyForProvider").mockResolvedValue({
    mode: "api-key",
    apiKey: "synthetic-google-key",
    profileId: "google:research",
    source: "profile",
  });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => jsonResponse({ id: "account-bound", status: "in_progress" }));
  vi.stubGlobal("fetch", fetch);
  const config = { enabled: true, profileId: "google:research" };
  const owner = await fixture(config);
  expect(await owner.request({ version: 1, action: "start", question: "River" })).toMatchObject({
    ok: true,
  });
  const handle = { interactionId: "account-bound", profileId: "google:research" };
  const switched = await fixture({ enabled: true, profileId: "google:another" }, owner.directory);
  expect(await switched.request({ version: 1, action: "poll", handle })).toMatchObject({
    ok: false,
    state: "blocked",
  });
  auth.mockResolvedValueOnce({
    mode: "api-key",
    apiKey: "different-account-key",
    profileId: "google:research",
    source: "profile",
  });
  expect(await owner.request({ version: 1, action: "poll", handle })).toMatchObject({
    ok: false,
    state: "blocked",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockImplementationOnce(async () => {
    await owner.dispose();
    return jsonResponse({
      id: "account-bound",
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: "Late private report." }] }],
    });
  });
  const late = await owner.request({ version: 1, action: "poll", handle });
  expect(late).toMatchObject({ ok: false });
  expect(JSON.stringify(late)).not.toContain("Late private report.");
  expect(fetch).toHaveBeenCalledTimes(2);
  const restarted = await fixture(config, owner.directory);
  expect(await restarted.request({ version: 1, action: "poll", handle })).toMatchObject({
    ok: true,
  });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("snapshots the checked native handle before the binding lookup await", async () => {
  mockPinnedHostnameResolution();
  vi.spyOn(authRuntime, "resolveApiKeyForProvider").mockResolvedValue({
    mode: "api-key",
    apiKey: "synthetic-google-key",
    profileId: "google:research",
    source: "profile",
  });
  const handle = { interactionId: "owned-interaction", profileId: "google:research" };
  let mutate = false;
  const entry = await fixture({ enabled: true, profileId: "google:research" }, undefined, () => {
    if (mutate) {
      handle.interactionId = "foreign-interaction";
    }
  });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(jsonResponse({ id: "owned-interaction", status: "in_progress" }));
  vi.stubGlobal("fetch", fetch);
  expect(
    await entry.request({ version: 1, action: "start", question: "Owned river" }),
  ).toMatchObject({ ok: true });
  const foreign = await fixture({ enabled: true, profileId: "google:research" }, entry.directory);
  foreign.authority.target.sessionKey = "agent:main:foreign-session";
  fetch.mockResolvedValueOnce(jsonResponse({ id: "foreign-interaction", status: "in_progress" }));
  expect(
    await foreign.request({ version: 1, action: "start", question: "Foreign river" }),
  ).toMatchObject({ ok: true });
  fetch.mockImplementation(async (url) =>
    jsonResponse({
      id: requestUrl(url).endsWith("/foreign-interaction")
        ? "foreign-interaction"
        : "owned-interaction",
      status: "in_progress",
    }),
  );
  mutate = true;
  const response = await entry.request({ version: 1, action: "poll", handle });
  expect(handle.interactionId).toBe("foreign-interaction");
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(requestUrl(fetch.mock.calls[2]![0])).toMatch(/\/owned-interaction$/);
  expect(response).toMatchObject({
    ok: true,
    value: { handle: { interactionId: "owned-interaction" } },
  });
});
