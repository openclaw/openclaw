import type { RepositorySourceV1 } from "openclaw/plugin-sdk/repository-sources";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../../src/config/runtime-snapshot.js";
import { createRepositorySources } from "../../../../src/gateway/repository-sources.js";
import type { RepositoryWorkerProjectSnapshot } from "../../../../src/gateway/worker-environments/repository-project-source.schema.js";
import { createRepositorySourcesFixture } from "../../../../src/gateway/worker-environments/repository-source.test-support.js";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "../../../../src/plugin-sdk/plugin-test-contracts.js";
import { getPluginInstance } from "../../../../src/plugins/plugin-instance-scope.js";
import { createRepositorySourceFixture } from "../../../../src/plugins/repository-source.test-support.js";
import { createPluginRecord } from "../../../../src/plugins/status.test-helpers.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createGitHubRepositorySource } from "../../repository-source-api.js";

const mocks = vi.hoisted(() => ({
  captureAgentLifecycleBinding: vi.fn(),
  matchesAgentLifecycleBinding: vi.fn(),
  matchesAgentLifecycleBindingAsync: vi.fn(),
  prepareGitHubReadIdentity: vi.fn(),
  prepareGitPack: vi.fn(),
}));
// mock-isolation: HTTP admission tests inject retirement during awaits without a database lifecycle owner.
vi.mock("../../../../src/agents/agent-lifecycle-registry.js", () => ({
  captureAgentLifecycleBinding: mocks.captureAgentLifecycleBinding,
  matchesAgentLifecycleBinding: mocks.matchesAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync: mocks.matchesAgentLifecycleBindingAsync,
}));
vi.mock("../../tool-identity-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../tool-identity-api.js")>()),
  GitHubIdentityError: (await import("../../read-identity-api.js")).GitHubIdentityError,
  prepareGitHubReadIdentity: mocks.prepareGitHubReadIdentity,
}));
vi.mock("../../../../src/secrets/runtime-state.js", () => ({
  getActiveSecretsRuntimeConfigSnapshot: () => undefined,
}));
vi.mock(
  "../../../../src/gateway/worker-environments/repository-git-pack.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../../src/gateway/worker-environments/repository-git-pack.js")
    >()),
    fetchRepositoryCheckoutPack: mocks.prepareGitPack,
  }),
);

import { prepareRepositoryWorkerProjectSource } from "../../../../src/gateway/worker-environments/repository-project-admission.js";
import { readRepositoryWorkerProjectSnapshot } from "../../../../src/gateway/worker-environments/repository-project-source.js";

const commit = "a".repeat(40);
const rootTree = "b".repeat(40);
const setupTree = "c".repeat(40);
const recipe = "d".repeat(40);
const repositoryUrl = "https://github.com/acme/project.git";
let observedRepositoryUrl = repositoryUrl;
const agent = { agentId: "main", provenance: null };
let sources: ReturnType<typeof createRepositorySourcesFixture>;
const admission = {
  namespace: "test-gateway",
  getRepositorySources: () => sources,
  getConfig: () => ({}),
  assertCurrent: () => {},
};
const initial = { ...admission, repository: { agentId: "main", url: repositoryUrl } };

describe("repository project admission", () => {
  let selection: Exclude<
    RepositoryWorkerProjectSnapshot["source"]["owner"]["identity"],
    { source: "plugin" }
  >;
  let token: string | undefined;
  let selected: boolean;
  let repositoryId: string;
  let privateRepository: boolean;
  let recipeMode: string;
  let truncated: boolean;
  let unavailable: boolean;
  let rootEntries: Record<string, unknown>[];
  let blobs: Record<string, string>;
  let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
  const repositoryNode = () => ({
    __typename: "Repository",
    node_id: repositoryId,
    clone_url: observedRepositoryUrl.replace(/\.git$/u, ""),
    private: privateRepository,
    object: { __typename: "Commit", sha: commit, tree: { sha: rootTree } },
  });
  const requestPaths = () =>
    fetchImpl.mock.calls.map(([input]) => new URL(new Request(input).url).pathname);

  beforeEach(() => {
    setRuntimeConfigSnapshot({});
    sources = createRepositorySourcesFixture();
    observedRepositoryUrl = repositoryUrl;
    selection = { source: "system-configured", profileId: `ghp_${"1".repeat(32)}`, accountId: 1 };
    token = "synthetic-github-source-token";
    selected = true;
    repositoryId = "R_fixture_project";
    privateRepository = false;
    recipeMode = "100755";
    truncated = false;
    unavailable = false;
    rootEntries = [{ path: ".openclaw", type: "tree", mode: "040000", sha: setupTree }];
    blobs = {};
    mocks.captureAgentLifecycleBinding.mockReset().mockResolvedValue(agent);
    mocks.prepareGitPack.mockReset().mockResolvedValue("/synthetic/source.pack");
    mocks.matchesAgentLifecycleBinding.mockReset().mockReturnValue(true);
    mocks.matchesAgentLifecycleBindingAsync.mockReset().mockResolvedValue(true);
    mocks.prepareGitHubReadIdentity.mockReset().mockImplementation(async ({ assertActive }) => {
      assertActive();
      const admittedToken = token;
      const assertSelected = () => {
        assertActive();
        if (!selected) {
          throw new Error("GitHub identity changed");
        }
      };
      return {
        token: admittedToken,
        selection: structuredClone(selection),
        cacheScope: "credential-scoped-memory-only",
        assertSelected,
        revalidate: async () => {
          assertSelected();
          if (admittedToken !== token) {
            throw new Error("GitHub credential changed");
          }
        },
      };
    });
    fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(new Request(input).url);
      // Enterprise REST shares the same fixture repository behind its supported API prefix.
      url.pathname = url.pathname.replace(/^\/api\/v3(?=\/)/u, "");
      let value: unknown;
      if (url.pathname === "/graphql" || url.pathname === "/api/graphql") {
        if (unavailable) {
          return new Response(null, { status: 404 });
        }
        value = { data: { node: repositoryNode() } };
      } else if (url.pathname === "/repos/acme/project") {
        if (unavailable) {
          return new Response(null, { status: 404 });
        }
        value = {
          node_id: repositoryId,
          clone_url: observedRepositoryUrl,
          private: privateRepository,
          default_branch: "main",
        };
      } else if (url.pathname.startsWith("/repos/acme/project/commits/")) {
        value = { sha: commit, commit: { tree: { sha: rootTree } } };
      } else if (url.pathname === `/repos/acme/project/git/commits/${commit}`) {
        value = { sha: commit, tree: { sha: rootTree } };
      } else if (url.pathname === `/repos/acme/project/git/trees/${rootTree}`) {
        value = {
          sha: rootTree,
          truncated,
          tree: rootEntries,
        };
      } else if (url.pathname === `/repos/acme/project/git/trees/${setupTree}`) {
        value = {
          sha: setupTree,
          truncated,
          tree: [{ path: "worktree-setup.sh", type: "blob", mode: recipeMode, sha: recipe }],
        };
      } else if (url.pathname.startsWith("/repos/acme/project/git/blobs/")) {
        const sha = url.pathname.split("/").at(-1) ?? "";
        const content = blobs[sha];
        if (content === undefined) {
          throw new Error("Unexpected fixture blob request");
        }
        value = {
          sha,
          size: Buffer.byteLength(content),
          encoding: "base64",
          content: Buffer.from(content).toString("base64"),
        };
      } else {
        throw new Error("Unexpected fixture metadata request");
      }
      return new Response(JSON.stringify(value));
    });
    vi.stubGlobal("fetch", fetchImpl);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    clearRuntimeConfigSnapshot();
  });

  const nativeSnapshot = (
    key = "5f3a252d4721416c63de96e5736650e1b83d356e31df48b7442ec4d60ea17189",
  ) => ({
    key,
    baseCommit: commit,
    source: {
      kind: "repository" as const,
      url: repositoryUrl,
      repositoryId,
      owner: { agent, identity: structuredClone(selection) },
    },
  });
  // Fixed predecessor keys protect native cache identity and visibility partitioning.
  it.each([
    ["anonymous", false, "64a61de5d5873d98cd8e79d4ff7075197c58638f7e1696dd2ecdafa4b93b03c5"],
    ["system-detected", false, "a64403a5856294a05363749d776f039b0ff2f044d0aae52f35facf5d9e6c8a31"],
    ["system-detected", true, "ae7b9f4cad982c6f04cf82f6c9be1fcc995f9fe9b587ff7c0916cb177ef49fbb"],
    [
      "system-configured",
      false,
      "5f3a252d4721416c63de96e5736650e1b83d356e31df48b7442ec4d60ea17189",
    ],
    ["system-configured", true, "bdcbb15850d4c14b92f2de8c5a35ed274b7aa19542c50f91e2a1de1b8c672e2e"],
    ["agent-override", false, "66187e81867665a2596fdcb34a3dede11706eef5eae8bdfe265d2b79c1b0ac56"],
    ["agent-override", true, "b10aa1726cdf728adaa57e1a4ef5ae46cbee96c7fb2409e2f348c3372e8284ca"],
  ] as const)("reopens a native %s snapshot (private=%s)", async (source, isPrivate, key) => {
    selection =
      source === "anonymous"
        ? { source }
        : source === "system-detected"
          ? { source, accountId: 1 }
          : { source, accountId: 1, profileId: `ghp_${"1".repeat(32)}` };
    privateRepository = isPrivate;
    if (source === "anonymous") {
      token = undefined;
    }
    const expected = nativeSnapshot(key);
    const reopened = await prepareRepositoryWorkerProjectSource({ ...admission, expected });
    expect(reopened.project).toEqual(expected);
    selection = { source: "system-detected", accountId: 2 };
    await expect(reopened.revalidate()).rejects.toThrow("identity changed");
  });

  it.each(["account", "profile", "visibility", "repository", "commit", "hash", "agent"] as const)(
    "refuses native recovery after %s drift",
    async (change) => {
      const expected = nativeSnapshot();
      if (change === "account" && selection.source !== "anonymous") {
        selection.accountId = 2;
      } else if (change === "profile" && selection.source === "system-configured") {
        selection.profileId = `ghp_${"2".repeat(32)}`;
      } else if (change === "visibility") {
        privateRepository = true;
      } else if (change === "repository") {
        repositoryId = "R_recreated_project";
      } else if (change === "commit") {
        expected.baseCommit = "e".repeat(40);
      } else if (change === "hash") {
        expected.key = "f".repeat(64);
      } else if (change === "agent") {
        mocks.matchesAgentLifecycleBindingAsync.mockResolvedValue(false);
      }
      await expect(
        prepareRepositoryWorkerProjectSource({ ...admission, expected }),
      ).rejects.toThrow("identity changed");
    },
  );

  it.each(["retired", "unavailable", "changed URL"] as const)(
    "does not redirect native recovery to another source when GitHub is %s",
    async (change) => {
      const registry = createPluginRegistryFixture();
      const replacement = createPluginRegistryFixture();
      let accepts = true;
      const github = createGitHubRepositorySource(
        () => ({}),
        async () => {},
      );
      const alternatePrepare = vi.fn();
      const canonical = createRepositorySourceFixture(
        {
          ...github,
          resolve: (url) => (accepts ? github.resolve(url) : undefined),
        },
        registry.registry,
        "github-repositories",
      );
      const alternate = {
        ...github,
        worker: { ...github.worker!, prepare: alternatePrepare },
      };
      createRepositorySourceFixture(alternate, registry.registry, "other-forge");
      createRepositorySourceFixture(alternate, replacement.registry, "other-forge");
      let active = registry.registry.registry;
      const getRepositorySources = () =>
        createRepositorySources(new AbortController().signal, active);
      const expected = nativeSnapshot();
      const reopened = await prepareRepositoryWorkerProjectSource({
        ...admission,
        getRepositorySources,
        expected,
      });
      expect(reopened.project).toEqual(expected);
      if (change === "retired") {
        await canonical.instance.dispose();
        await expect(reopened.revalidate()).rejects.toThrow();
      } else if (change === "unavailable") {
        active = replacement.registry.registry;
      } else {
        accepts = false;
        expect(reopened.assertCurrent).toThrow();
      }
      fetchImpl.mockClear();
      await expect(
        prepareRepositoryWorkerProjectSource({ ...admission, getRepositorySources, expected }),
      ).rejects.toThrow();
      expect(alternatePrepare).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("retains the recorded source of reusable capacity when another source accepts its URL", async () => {
    const host = new AbortController();
    const initialRegistry = createPluginRegistryFixture();
    const replacementRegistry = createPluginRegistryFixture();
    const secondPrepare = vi.fn();
    const provider = (pluginId: string): RepositorySourceV1 => ({
      id: "repos",
      resolve: (url) => (url === repositoryUrl ? { url, name: "acme/project" } : undefined),
      async prepare() {
        throw new Error("Unexpected local clone");
      },
      worker: {
        isIdentityCurrent: () => true,
        async prepare(input) {
          if (pluginId === "forge-b") {
            secondPrepare();
          }
          input.assertCurrent();
          return {
            repositoryId,
            identityKey: "anonymous-fixture",
            private: false,
            baseCommit: commit,
            tree: rootTree,
            assertCurrent: input.assertCurrent,
            async readTree() {
              return [];
            },
            async readBlob() {
              throw new Error("Unexpected recipe blob");
            },
            async confirmAdmission() {},
            async revalidate() {
              input.assertCurrent();
            },
            async prepareGitPack() {
              throw new Error("Unexpected pack preparation");
            },
          };
        },
        async checkout() {
          throw new Error("Unexpected checkout");
        },
      },
    });
    const register = (fixture: typeof initialRegistry, id: string) => {
      const record = createPluginRecord({
        id,
        repositorySources: [{ id: "repos", label: "Forge", searchMethod: "forge.search" }],
      });
      registerTestPlugin({
        ...fixture,
        record,
        register: (api) => api.registerRepositorySource(provider(id)),
      });
      return getPluginInstance(record)!;
    };
    const first = register(initialRegistry, "forge-a");
    let activeRegistry = initialRegistry.registry.registry;
    const instances = [first];
    const getRepositorySources = () => createRepositorySources(host.signal, activeRegistry);
    try {
      const admitted = await prepareRepositoryWorkerProjectSource({
        ...initial,
        getRepositorySources,
      });
      const persisted = readRepositoryWorkerProjectSnapshot(structuredClone(admitted.project));
      assert(persisted);
      expect(persisted.source.repositorySourceId).toBe("forge-a/repos");
      instances.push(register(initialRegistry, "forge-b"));
      await expect(
        prepareRepositoryWorkerProjectSource({
          ...admission,
          getRepositorySources,
          expected: persisted,
        }),
      ).resolves.toMatchObject({ project: persisted });
      await first.dispose();
      await expect(admitted.revalidate()).rejects.toThrow();
      await expect(
        prepareRepositoryWorkerProjectSource({
          ...admission,
          getRepositorySources,
          expected: persisted,
        }),
      ).rejects.toThrow();
      expect(secondPrepare).not.toHaveBeenCalled();
      instances.push(register(replacementRegistry, "forge-b"));
      activeRegistry = replacementRegistry.registry.registry;
      const fresh = await prepareRepositoryWorkerProjectSource({
        ...initial,
        getRepositorySources,
      });
      expect(fresh.project.source.repositorySourceId).toBe("forge-b/repos");
      expect(secondPrepare).toHaveBeenCalledOnce();
    } finally {
      host.abort();
      await Promise.all(instances.map((instance) => instance.dispose()));
    }
  });

  it("admits the declarative recipe before an executable fallback from immutable blobs", async () => {
    const blob = "e".repeat(40);
    rootEntries.push({ path: ".devcontainer.json", type: "blob", mode: "100644", sha: blob });
    blobs[blob] = '{ // cloud preparation\n "onCreateCommand": ["npm", "ci"], "image": "ignored" }';
    const result = await prepareRepositoryWorkerProjectSource(initial);
    expect(result.setupRecipe).toBe(blob);
    expect(result.recipe).toMatchObject({
      source: "devcontainer",
      identity: blob,
      inputs: { ".devcontainer.json": blob },
      onCreate: ["npm", "ci"],
      ignoredPropertiesNote: "devcontainer image ignored on cloud machines",
    });
    expect(requestPaths().filter((path) => path.includes("/git/trees/"))).toEqual([
      `/repos/acme/project/git/trees/${rootTree}`,
    ]);
    expect(requestPaths().filter((path) => path.includes("/git/blobs/"))).toEqual([
      `/repos/acme/project/git/blobs/${blob}`,
    ]);
  });

  it("records detected install identity using immutable lockfile blobs without fetching their contents", async () => {
    const lock = "e".repeat(40);
    const packageBlob = "f".repeat(40);
    rootEntries = [
      { path: "yarn.lock", type: "blob", mode: "100644", sha: lock },
      { path: "package.json", type: "blob", mode: "100644", sha: packageBlob },
    ];
    blobs[packageBlob] = '{ "packageManager": "yarn@4.0.0" }';
    const result = await prepareRepositoryWorkerProjectSource(initial);
    const identity = "d66a6ba34bd261aca84e16d556a81df1d3c3105fa71ad1a175af1be237a8412a";
    expect(result.setupRecipe).toBe(identity);
    expect(result.recipe).toEqual({
      source: "detected",
      identity,
      inputs: { "yarn.lock": lock, "package.json": packageBlob },
      env: { COREPACK_ENABLE_AUTO_PIN: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
      detectedInstall:
        'mkdir -p "$HOME/.local/bin" && corepack enable --install-directory "$HOME/.local/bin" && PATH="$HOME/.local/bin:$PATH" yarn install --immutable',
    });
    expect(requestPaths().filter((path) => path.includes("/git/blobs/"))).toEqual([
      `/repos/acme/project/git/blobs/${packageBlob}`,
    ]);
    fetchImpl.mockClear();
    const cached = await prepareRepositoryWorkerProjectSource({
      ...initial,
      knownRecipe: () => ({
        setupRecipe: result.setupRecipe,
        recipe: result.recipe,
      }),
    });
    expect(cached.recipe).toEqual(result.recipe);
    expect(
      requestPaths().every(
        (path) => !path.includes("/git/trees/") && !path.includes("/git/blobs/"),
      ),
    ).toBe(true);
  });

  it("reparses pre-secret devcontainer caches before granting repository setup", async () => {
    const blob = "e".repeat(40);
    rootEntries.push({ path: ".devcontainer.json", type: "blob", mode: "100644", sha: blob });
    blobs[blob] = '{"secrets":{"PACKAGE_TOKEN":{}},"onCreateCommand":"npm ci"}';
    const admitted = await prepareRepositoryWorkerProjectSource(initial);
    assert.isDefined(admitted.recipe);
    const legacyRecipe = structuredClone(admitted.recipe);
    delete legacyRecipe.secretNames;
    fetchImpl.mockClear();
    const refreshed = await prepareRepositoryWorkerProjectSource({
      ...initial,
      knownRecipe: () => ({ setupRecipe: blob, recipe: legacyRecipe }),
    });
    expect(refreshed.recipe?.secretNames).toEqual(["PACKAGE_TOKEN"]);
    expect(requestPaths()).toContain(`/repos/acme/project/git/blobs/${blob}`);
    fetchImpl.mockClear();
    const reused = await prepareRepositoryWorkerProjectSource({
      ...initial,
      knownRecipe: () => ({
        setupRecipe: blob,
        recipe: refreshed.recipe,
      }),
    });
    expect(reused.recipe?.secretNames).toEqual(["PACKAGE_TOKEN"]);
    expect(requestPaths().some((path) => path.includes("/git/blobs/"))).toBe(false);
  });

  it("rejects cached command facts whose recipe identity disagrees with admission", async () => {
    const admitted = await prepareRepositoryWorkerProjectSource(initial);
    await expect(
      prepareRepositoryWorkerProjectSource({
        ...initial,
        knownRecipe: () => ({
          setupRecipe: admitted.setupRecipe,
          recipe: {
            source: "script",
            identity: "e".repeat(40),
            inputs: { ".openclaw/worktree-setup.sh": "e".repeat(40) },
            env: {},
            onCreate: ["./.openclaw/worktree-setup.sh"],
          },
        }),
      }),
    ).rejects.toThrow("identity changed");
  });

  it("revalidates an enterprise repository once before and after its authenticated pack", async () => {
    setRuntimeConfigSnapshot({
      gateway: {},
      plugins: {
        entries: {
          "github-repositories": {
            config: {
              host: "ghe.example.test",
              apiBaseUrl: "https://ghe.example.test/api/v3",
            },
          },
        },
      },
    });
    observedRepositoryUrl = "https://ghe.example.test/acme/project.git";
    const admitted = await prepareRepositoryWorkerProjectSource({
      ...initial,
      repository: { ...initial.repository, url: observedRepositoryUrl },
    });

    expect(admitted).toHaveProperty("prepareGitPack");
    fetchImpl.mockClear();
    let requestsBeforePack: string[] = [];
    mocks.prepareGitPack.mockImplementationOnce(async () => {
      requestsBeforePack = requestPaths();
      return "/synthetic/source.pack";
    });
    await expect(
      admitted.prepareGitPack?.({
        temporaryRoot: "/synthetic/temporary",
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("/synthetic/source.pack");
    expect(mocks.prepareGitPack).toHaveBeenCalledWith(
      expect.objectContaining({
        url: observedRepositoryUrl,
        httpAuthorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      }),
    );
    const revalidation = ["/api/graphql", "/api/v3/repos/acme/project"];
    expect(requestsBeforePack).toEqual(revalidation);
    expect(requestPaths()).toEqual([...revalidation, ...revalidation]);
  });

  it.each(["HEAD", "refs/tags/v1", "feature/ready"])(
    "pins %s through the commit resolver and records executable recipe identity without credentials",
    async (ref) => {
      const result = await prepareRepositoryWorkerProjectSource({
        ...initial,
        repository: { ...initial.repository, ref },
        knownRecipe: () => undefined,
      });
      expect(result.project).toMatchObject({
        baseCommit: commit,
        source: {
          kind: "repository",
          url: repositoryUrl,
          repositoryId,
          owner: { agent, identity: { source: "plugin", key: expect.any(String) } },
        },
      });
      expect(result.setupRecipe).toBe(recipe);
      expect(requestPaths().filter((path) => path.includes("/git/trees/"))).toHaveLength(2);
      const urls = fetchImpl.mock.calls.map(([url]) => new Request(url).url);
      const expectedRef =
        ref === undefined || ref === "HEAD" ? "heads/main" : ref.replace(/^refs\//u, "");
      expect(urls).toContain(
        `https://api.github.com/repos/acme/project/commits/${encodeURIComponent(expectedRef)}?per_page=1`,
      );
      expect(urls.every((url) => !url.includes("recursive"))).toBe(true);
      expect(JSON.stringify(result.project)).not.toContain(token);
      expect(JSON.stringify(result.project)).not.toContain("credential-scoped-memory-only");
      expect(result.project).not.toHaveProperty("root");
    },
  );

  it.each(["revalidate"] as const)(
    "rejects invalid GraphQL repository/object metadata during %s without a REST fallback",
    async () => {
      const admitted = await prepareRepositoryWorkerProjectSource(initial);
      const node = repositoryNode();
      const responses = [
        {},
        { data: null },
        { data: { node: null } },
        { data: { node: { ...node, __typename: "User" } } },
        { data: { node: { ...node, node_id: "R_replaced_project" } } },
        { data: { node: { ...node, clone_url: "https://github.com/acme/another" } } },
        { data: { node: { ...node, private: undefined } } },
        { data: { node: { ...node, private: true } } },
        { data: { node: { ...node, object: null } } },
        { data: { node: { ...node, object: { ...node.object, __typename: "Tree" } } } },
        { data: { node: { ...node, object: { ...node.object, sha: "e".repeat(40) } } } },
        { data: { node: { ...node, object: { ...node.object, tree: null } } } },
        { data: { node: { ...node, object: { ...node.object, tree: { sha: "invalid" } } } } },
        { data: { node }, errors: [{ type: "FORBIDDEN" }] },
        { data: { node }, errors: [{ type: "INTERNAL", message: "private-diagnostic" }] },
        { data: { node }, errors: {} },
        { errors: [{ type: "FORBIDDEN" }, { type: "INTERNAL" }] },
      ];
      for (const response of responses) {
        fetchImpl.mockClear().mockResolvedValueOnce(new Response(JSON.stringify(response)));
        const pending = admitted.revalidate();
        await expect(pending).rejects.toThrow();
        expect(requestPaths()).toEqual(["/graphql"]);
      }
    },
  );

  it.each(["repository", "visibility", "access"] as const)(
    "rejects %s changes after the immutable-node read",
    async (change) => {
      const admitted = await prepareRepositoryWorkerProjectSource(initial);
      const response = { data: { node: repositoryNode() } };
      fetchImpl.mockClear().mockImplementationOnce(async () => {
        if (change === "repository") {
          repositoryId = "R_recreated_project";
        }
        if (change === "visibility") {
          privateRepository = true;
        }
        if (change === "access") {
          unavailable = true;
        }
        return new Response(JSON.stringify(response));
      });
      await expect(admitted.revalidate()).rejects.toThrow();
      expect(requestPaths()).toEqual(["/graphql", "/repos/acme/project"]);
    },
  );

  it.each(["http forbidden", "forbidden", "insufficient scopes"] as const)(
    "preserves the complete REST fence for a public token with %s GraphQL access",
    async (refusal) => {
      const admitted = await prepareRepositoryWorkerProjectSource(initial);
      fetchImpl.mockClear().mockResolvedValueOnce(
        refusal === "http forbidden"
          ? new Response(
              JSON.stringify({ message: "Resource not accessible by personal access token" }),
              { status: 403 },
            )
          : new Response(
              JSON.stringify({
                data: null,
                errors: [{ type: refusal === "forbidden" ? "FORBIDDEN" : "INSUFFICIENT_SCOPES" }],
              }),
            ),
      );
      await expect(admitted.revalidate()).resolves.toBeUndefined();
      expect(requestPaths()).toEqual([
        "/graphql",
        "/repos/acme/project",
        `/repos/acme/project/git/commits/${commit}`,
        "/repos/acme/project",
      ]);
    },
  );

  it.each(["agent", "identity", "credential", "caller"] as const)(
    "rejects %s revocation after successful or refused GraphQL reads without falling back",
    async (revoked) => {
      const admitted = await prepareRepositoryWorkerProjectSource(initial);
      const originalToken = token;
      for (const status of [200, 403]) {
        selected = true;
        token = originalToken;
        mocks.matchesAgentLifecycleBinding.mockReturnValue(true);
        const controller = new AbortController();
        fetchImpl.mockClear().mockImplementationOnce(async () => {
          if (revoked === "agent") {
            mocks.matchesAgentLifecycleBinding.mockReturnValue(false);
          }
          if (revoked === "identity") {
            selected = false;
          }
          if (revoked === "credential") {
            token = "replaced-credential";
          }
          if (revoked === "caller") {
            controller.abort();
          }
          return new Response(
            JSON.stringify(
              status === 403
                ? { message: "Resource not accessible by personal access token" }
                : { data: { node: repositoryNode() } },
            ),
            { status },
          );
        });
        await expect(admitted.revalidate(controller.signal)).rejects.toThrow();
        expect(requestPaths()).toEqual(["/graphql"]);
      }
    },
  );

  it.each<{ label: string; status: number; body?: string; headers?: Record<string, string> }>([
    { label: "authentication", status: 401, body: "{}" },
    { label: "missing endpoint", status: 404, body: "{}" },
    { label: "malformed JSON", status: 200, body: "{" },
    { label: "ambiguous forbidden", status: 403, body: "{}" },
    {
      label: "quota at HTTP 403",
      status: 403,
      headers: { "x-ratelimit-remaining": "42" },
      body: JSON.stringify({ errors: [{ type: "RATE_LIMITED" }] }),
    },
    { label: "redirect", status: 307, headers: { location: "https://api.github.com/graphql" } },
  ])(
    "does not reinterpret $label as unavailable GraphQL capability",
    async ({ status, body, headers }) => {
      const admitted = await prepareRepositoryWorkerProjectSource(initial);
      fetchImpl.mockClear().mockResolvedValueOnce(new Response(body, { status, headers }));
      await expect(admitted.revalidate()).rejects.toThrow();
      expect(requestPaths()).toEqual(["/graphql"]);
    },
  );

  it.each([undefined, recipe])(
    "reuses an exact known recipe %s without Git tree reads",
    async (setupRecipe) => {
      recipeMode = setupRecipe ? "100755" : "100644";
      const admitted = await prepareRepositoryWorkerProjectSource(initial);
      expect(admitted.setupRecipe).toBe(setupRecipe);
      fetchImpl.mockClear();
      const knownRecipe = vi.fn(() => ({ setupRecipe }));
      const result = await prepareRepositoryWorkerProjectSource({ ...initial, knownRecipe });
      expect(result.project).toEqual(admitted.project);
      expect(result.setupRecipe).toBe(setupRecipe);
      expect(knownRecipe).toHaveBeenCalledExactlyOnceWith(admitted.project);
      expect(requestPaths()).toEqual([
        "/repos/acme/project",
        "/repos/acme/project/commits/heads%2Fmain",
        "/repos/acme/project",
      ]);
    },
  );

  it("still rejects access loss after a known recipe hit", async () => {
    const admitted = await prepareRepositoryWorkerProjectSource(initial);
    fetchImpl.mockClear();
    await expect(
      prepareRepositoryWorkerProjectSource({
        ...initial,
        knownRecipe: () => {
          unavailable = true;
          return { setupRecipe: admitted.setupRecipe };
        },
      }),
    ).rejects.toThrow("HTTP 404");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(
      fetchImpl.mock.calls.every(([input]) => !new Request(input).url.includes("/git/trees/")),
    ).toBe(true);
  });

  it.each(["120000"])("does not authorize setup from mode %s", async (mode) => {
    recipeMode = mode;
    expect((await prepareRepositoryWorkerProjectSource(initial)).setupRecipe).toBeUndefined();
  });

  it("rejects incomplete trees rather than interpreting a missing recipe as no setup", async () => {
    truncated = true;
    await expect(prepareRepositoryWorkerProjectSource(initial)).rejects.toThrow(
      "tree metadata is incomplete",
    );
  });

  it("rejects oversized metadata and cross-repository redirects without a second request", async () => {
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ padding: "x".repeat(1024 * 1024) })),
    );
    await expect(prepareRepositoryWorkerProjectSource(initial)).rejects.toThrow("size limit");
    fetchImpl.mockClear().mockResolvedValueOnce(
      new Response(null, {
        status: 301,
        headers: { location: "https://api.github.com/repos/acme/another" },
      }),
    );
    await expect(prepareRepositoryWorkerProjectSource(initial)).rejects.toThrow("identity changed");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("admits private source with a separate key and retains credentials only in the pack producer", async () => {
    const publicSource = await prepareRepositoryWorkerProjectSource(initial);
    expect(publicSource.prepareGitPack).toBeUndefined();
    privateRepository = true;
    const admitted = await prepareRepositoryWorkerProjectSource(initial);
    expect(admitted).toBeDefined();
    expect(admitted.project.key).not.toBe(publicSource.project.key);
    expect(admitted.project.source).toEqual(publicSource.project.source);
    expect(JSON.stringify(admitted)).not.toContain(token);
    const storedProject = JSON.stringify(admitted.project);
    const reopened = await prepareRepositoryWorkerProjectSource({
      ...admission,
      expected: JSON.parse(storedProject),
    });
    expect(reopened.project).toEqual(admitted.project);
    token = "rotated-synthetic-token";
    const signal = new AbortController().signal;
    await expect(reopened.prepareGitPack!({ temporaryRoot: "/synthetic", signal })).resolves.toBe(
      "/synthetic/source.pack",
    );
    expect(mocks.prepareGitPack).toHaveBeenCalledExactlyOnceWith({
      url: repositoryUrl,
      baseCommit: commit,
      httpAuthorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      temporaryRoot: "/synthetic",
      signal,
      assertCurrent: expect.any(Function),
    });
  });

  it.each(["caller", "account", "visibility", "during fetch"] as const)(
    "rejects private pack preparation after %s authority changes",
    async (change) => {
      privateRepository = true;
      const caller = new AbortController();
      const admitted = await prepareRepositoryWorkerProjectSource({
        ...initial,
        signal: caller.signal,
      });
      if (change === "caller") {
        caller.abort();
      }
      if (change === "account") {
        selected = false;
      }
      if (change === "visibility") {
        privateRepository = false;
      }
      if (change === "during fetch") {
        mocks.prepareGitPack.mockImplementationOnce(async () => {
          selected = false;
          return "/synthetic/source.pack";
        });
      }
      await expect(
        admitted.prepareGitPack!({
          temporaryRoot: "/synthetic",
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow();
      expect(mocks.prepareGitPack).toHaveBeenCalledTimes(change === "during fetch" ? 1 : 0);
    },
  );

  it("rejects visibility changes while the initial commit and recipe are being admitted", async () => {
    const implementation = fetchImpl.getMockImplementation()!;
    let repositoryReads = 0;
    fetchImpl.mockImplementation(async (input, init) => {
      if (
        new URL(new Request(input, init).url).pathname === "/repos/acme/project" &&
        ++repositoryReads === 2
      ) {
        privateRepository = true;
      }
      return implementation(input, init);
    });
    await expect(prepareRepositoryWorkerProjectSource(initial)).rejects.toThrow("identity changed");
  });

  it("separates anonymous scope and does not accept a private response without identity", async () => {
    const authenticated = await prepareRepositoryWorkerProjectSource(initial);
    token = undefined;
    selection = { source: "anonymous" };
    const anonymous = await prepareRepositoryWorkerProjectSource(initial);
    expect(anonymous.project.key).not.toBe(authenticated.project.key);
    expect(anonymous.project.source.owner.identity).toEqual({
      source: "plugin",
      key: expect.any(String),
    });
    privateRepository = true;
    await expect(anonymous.revalidate()).rejects.toThrow("identity changed");
  });

  it("fences owner replacement while allowing a completed admission's caller to close", async () => {
    let active = true;
    const controller = new AbortController();
    const result = await prepareRepositoryWorkerProjectSource({
      ...initial,
      signal: controller.signal,
      assertCurrent: () => {
        if (!active) {
          throw new Error("caller closed");
        }
      },
    });
    active = false;
    controller.abort();
    await expect(result.revalidate()).resolves.toBeUndefined();
    selection = { source: "system-configured", profileId: `ghp_${"1".repeat(32)}`, accountId: 2 };
    await expect(result.revalidate()).rejects.toThrow("identity changed");
    mocks.matchesAgentLifecycleBinding.mockReturnValue(false);
    expect(result.assertCurrent).toThrow("identity changed");
  });

  it("does not admit a result after authority closes during a metadata await", async () => {
    const controller = new AbortController();
    const response = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementationOnce(async (...args) => {
      const value = await response(...args);
      controller.abort();
      return value;
    });
    await expect(
      prepareRepositoryWorkerProjectSource({ ...initial, signal: controller.signal }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["capture", "preparation"] as const)(
    "does not read credentials after the caller closes during lifecycle %s",
    async (phase) => {
      const controller = new AbortController();
      const started = createDeferred();
      const release = createDeferred();
      if (phase === "capture") {
        mocks.captureAgentLifecycleBinding.mockImplementationOnce(async () => {
          started.resolve();
          await release.promise;
          return agent;
        });
      } else {
        mocks.matchesAgentLifecycleBindingAsync.mockImplementationOnce(async () => {
          started.resolve();
          await release.promise;
          return true;
        });
      }
      const pending = prepareRepositoryWorkerProjectSource({
        ...initial,
        signal: controller.signal,
      });
      await started.promise;
      controller.abort();
      release.resolve();

      await expect(pending).rejects.toThrow();
      expect(mocks.prepareGitHubReadIdentity).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("refuses preparation when the worker observes agent retirement", async () => {
    mocks.matchesAgentLifecycleBindingAsync.mockResolvedValueOnce(false);

    await expect(prepareRepositoryWorkerProjectSource(initial)).rejects.toThrow("identity changed");
    expect(mocks.prepareGitHubReadIdentity).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not expose native credential subprocess diagnostics as preparation errors", async () => {
    mocks.prepareGitHubReadIdentity.mockRejectedValueOnce(
      new Error("synthetic-private-diagnostic"),
    );
    await expect(prepareRepositoryWorkerProjectSource(initial)).rejects.toThrow(
      "could not be verified",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["initial", "refill", "revalidate"] as const)(
    "cancels a pending %s HTTP read",
    async (phase) => {
      const admitted = await prepareRepositoryWorkerProjectSource(initial);
      const controller = new AbortController();
      const started = createDeferred();
      fetchImpl.mockImplementationOnce(async (_input, init) => {
        const signal = init?.signal;
        if (!signal) {
          throw new Error("HTTP request has no cancellation signal");
        }
        started.resolve();
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Request aborted", "AbortError")),
            { once: true },
          );
        });
      });
      const request =
        phase === "initial"
          ? prepareRepositoryWorkerProjectSource({ ...initial, signal: controller.signal })
          : phase === "refill"
            ? prepareRepositoryWorkerProjectSource({
                ...admission,
                expected: admitted.project,
                signal: controller.signal,
              })
            : admitted.revalidate(controller.signal);
      await started.promise;
      controller.abort();
      await expect(request).rejects.toThrow();
    },
  );

  it("rejects mixed local/remote descriptors and unexpected persisted owner fields", async () => {
    const { project } = await prepareRepositoryWorkerProjectSource(initial);
    expect(readRepositoryWorkerProjectSnapshot({ ...project, preparation: {} })).toEqual(project);
    expect(() => readRepositoryWorkerProjectSnapshot({ ...project, root: "/local" })).toThrow(
      "invalid repository",
    );
    expect(() =>
      readRepositoryWorkerProjectSnapshot({ ...project, token: "unpersistable" }),
    ).toThrow("invalid repository");
    for (const owner of [
      { ...project.source.owner, identity: { source: "anonymous" } },
      { ...project.source.owner, token: "unpersistable" },
    ]) {
      expect(() =>
        readRepositoryWorkerProjectSnapshot({
          ...project,
          source: { ...project.source, owner },
        }),
      ).toThrow("invalid repository");
    }
  });
});
