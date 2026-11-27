import fs from "node:fs/promises";
import { afterEach, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type {
  ProviderModelRouteAuthRequirement,
  ProviderModelRouteCandidate,
  ProviderModelRouteResolution,
} from "../../plugin-sdk/provider-model-types.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createApiKeyCredential } from "./credential-fixtures.test-support.js";
import type { AuthProfileStore } from "./types.js";

export const TEST_PRIMARY_PROFILE_ID = "openai:primary@example.test";
export const TEST_SECONDARY_PROFILE_ID = "openai:secondary@example.test";

const authStoreMocks = vi.hoisted(() => {
  const emptyStore = (): AuthProfileStore => ({ version: 1, profiles: {} });
  const state = {
    hasSource: false,
    routeResolutions: new Map<string, ProviderModelRouteResolution>(),
    store: emptyStore(),
  };
  const calls = {
    ensureAuthProfileStoreAsync: vi.fn(async () => state.store),
    hasAnyAuthProfileStoreSourceAsync: vi.fn(() => state.hasSource),
    resolveProviderModelRoutes: vi.fn(
      ({ provider, modelId }: { provider: string; modelId?: string }) =>
        state.routeResolutions.get(`${provider}\0${modelId ?? ""}`) ?? null,
    ),
  };
  return {
    state,
    ...calls,
    reset() {
      state.hasSource = false;
      state.routeResolutions.clear();
      state.store = emptyStore();
      Object.values(calls).forEach((mock) => mock.mockReset());
      vi.clearAllMocks();
    },
  };
});

export { authStoreMocks };

vi.mock("./store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./store.js")>()),
  getRuntimeAuthProfileStoreSnapshot: () => authStoreMocks.state.store,
  findPersistedAuthProfileCredential: ({ profileId }: { profileId: string }) =>
    authStoreMocks.state.store.profiles[profileId],
}));
vi.mock("./source-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./source-check.js")>()),
  hasAnyAuthProfileStoreSourceAsync: authStoreMocks.hasAnyAuthProfileStoreSourceAsync,
}));
// mock-isolation: Session override cases use the fixture store without loading host credentials.
vi.mock("./store-runtime.js", () => ({
  ensureAuthProfileStoreAsync: authStoreMocks.ensureAuthProfileStoreAsync,
  loadAuthProfileStoreForRuntimeAsync: async () => authStoreMocks.state.store,
}));

// mock-isolation: Keep the real cooldown predicate without loading runtime usage writers.
vi.mock("./usage.js", async () => {
  const { isProfileInCooldown } = await import("./usage-state.js");
  return { isProfileInCooldown };
});

vi.mock("../../plugins/provider-model-routes.js", () => ({
  // Synthetic route IDs in this fixture are already canonical.
  createProviderModelCatalogIdNormalizer: () => (modelId: string) => modelId,
  resolveProviderModelCatalogId: ({ modelId }: { modelId: string }) => modelId,
  resolveProviderModelPolicySurface: () => null,
  resolveProviderModelRoutes: authStoreMocks.resolveProviderModelRoutes,
}));

const { resolveSessionAuthSelection } = await import("./session-override.js");
afterEach(() => authStoreMocks.reset());

export async function withAuthState<T>(run: (state: OpenClawTestState) => Promise<T>): Promise<T> {
  return await withOpenClawTestState({ layout: "state-only", prefix: "openclaw-auth-" }, run);
}

export function configureProviderRoutes(
  requirements: ProviderModelRouteAuthRequirement[],
  modelId = "gpt-5.6-sol",
): void {
  const routes = requirements.map<ProviderModelRouteCandidate>((authRequirement, index) => ({
    api: authRequirement === "api-key" ? "openai-responses" : "openai-chatgpt-responses",
    baseUrl: `https://route-${index}.example.test`,
    authRequirement,
    requestTransportOverrides: "none",
  }));
  const first = routes[0];
  if (first) {
    authStoreMocks.state.routeResolutions.set(`openai\0${modelId}`, {
      kind: "routes",
      routes: [first, ...routes.slice(1)],
    });
  }
}

export async function prepareCooldownAuthState(
  state: OpenClawTestState,
  options: { profileIds?: string[] } & Pick<AuthProfileStore, "usageStats"> = {},
): Promise<string> {
  const agentDir = state.agentDir();
  await fs.mkdir(agentDir, { recursive: true });
  authStoreMocks.state.hasSource = true;
  const profileIds = options.profileIds ?? [TEST_PRIMARY_PROFILE_ID];
  authStoreMocks.state.store = {
    version: 1,
    profiles: Object.fromEntries(
      profileIds.map((profileId) => [profileId, createApiKeyCredential("openai", "sk-test")]),
    ),
    order: { openai: profileIds },
    usageStats:
      options.usageStats ??
      Object.fromEntries(
        profileIds.map((profileId) => [profileId, { cooldownUntil: Date.now() + 60_000 }]),
      ),
  };
  return agentDir;
}

type SelectionOptions = Partial<Parameters<typeof resolveSessionAuthSelection>[0]>;
export function resolveSessionSelection(
  params: SelectionOptions & { agentDir: string; sessionEntry: SessionEntry },
) {
  return resolveSessionAuthSelection({
    ...params,
    sessionStore: params.sessionStore ?? {
      [params.sessionKey ?? "agent:main:main"]: params.sessionEntry,
    },
    agentId: params.agentId ?? "main",
    cfg: params.cfg ?? {},
    provider: params.provider ?? "openai",
    modelId: params.modelId ?? params.sessionEntry.model ?? "model-x",
    sessionKey: params.sessionKey ?? "agent:main:main",
    isNewSession: params.isNewSession ?? false,
  });
}

export async function resolveSession(params: Parameters<typeof resolveSessionSelection>[0]) {
  return (await resolveSessionSelection(params))?.profileId;
}

export function createAutomaticSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "s1",
    updatedAt: 1,
    authProfileOverride: TEST_PRIMARY_PROFILE_ID,
    authProfileOverrideSource: "auto",
    ...overrides,
  };
}
