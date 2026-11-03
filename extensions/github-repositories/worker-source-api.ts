import { isDeepStrictEqual } from "node:util";
import { getActiveSecretsRuntimeConfigSnapshot } from "openclaw/plugin-sdk/channel-secret-owner-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { MANAGED_GITHUB_PROFILE_ID_PATTERN } from "openclaw/plugin-sdk/native-github-account-host";
import {
  performRepositoryCheckout,
  prepareRepositoryCheckoutPack,
  type RepositorySourceV1,
  type RepositoryWorkerReadLease,
} from "openclaw/plugin-sdk/repository-sources";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveConfiguredGitHubHost } from "./host-api.js";
import { materializeProjectClone } from "./project-clone-api.js";
import { readProjectCheckoutRemoteHead, ProjectCloneError } from "./project-clone-runtime-api.js";
import { parseProjectGitUrl } from "./project-url-api.js";
import { gitHubPublicApi } from "./public-api.js";
import type { PreparedGitHubSourceReadIdentity } from "./read-identity-api.js";
import {
  GitHubIdentityError,
  prepareGitHubReadIdentity,
  resolveConfiguredGitHubToolIdentity,
} from "./tool-identity-api.js";
type RepositoryWorkerSource = NonNullable<RepositorySourceV1["worker"]>;
type RepositoryReadIdentityFacts =
  | { source: "anonymous" }
  | { source: "system-detected"; accountId: number }
  | { source: "system-configured" | "agent-override"; accountId: number; profileId: string };

const GitObject = /^[a-f0-9]{40}$/u;
// Commit lookup requests one changed file; trees are nonrecursive and inspect
// only the root and recipe directories. Oversized/truncated metadata is not absence.
const METADATA_MAX_BYTES = 1024 * 1024;
// Bind object resolution to the immutable repository, never its reusable name.
const PINNED_REPOSITORY_QUERY = `query PinnedRepository($repositoryId: ID!, $commit: GitObjectID!) {
  node(id: $repositoryId) {
    __typename
    ... on Repository {
      node_id: id
      clone_url: url
      private: isPrivate
      object(oid: $commit) {
        __typename
        ... on Commit { sha: oid tree { sha: oid } }
      }
    }
  }
}`;
function objectSha(value: unknown): string {
  if (!isRecord(value) || typeof value.sha !== "string" || !GitObject.test(value.sha)) {
    throw new Error("GitHub returned invalid repository object metadata; retry preparation.");
  }
  return value.sha;
}

function sourceChanged(): never {
  throw new Error(
    "Prepared repository identity changed; retry with the current source and account.",
  );
}

function recordedIdentity(
  selection: PreparedGitHubSourceReadIdentity["selection"],
): RepositoryReadIdentityFacts {
  if (selection.source === "anonymous") {
    return { source: "anonymous" };
  }
  if (selection.source === "system-detected") {
    return { source: selection.source, accountId: selection.accountId };
  }
  if (!selection.profileId || !MANAGED_GITHUB_PROFILE_ID_PATTERN.test(selection.profileId)) {
    sourceChanged();
  }
  return {
    source: selection.source,
    accountId: selection.accountId,
    profileId: selection.profileId,
  };
}

async function prepareGitHubWorkerSource(
  params: Parameters<RepositoryWorkerSource["prepare"]>[0],
  getConfig: () => OpenClawConfig,
  refresh: (agentId: string) => Promise<void>,
): Promise<RepositoryWorkerReadLease> {
  const expected = params.expected;
  const request = params;
  if (expected && !request.baseCommit) {
    throw new Error("Pinned repository source requires its exact commit.");
  }
  const url = parseProjectGitUrl(request.url, resolveConfiguredGitHubHost(getConfig()))?.url;
  if (!url || (request.baseCommit !== undefined && !GitObject.test(request.baseCommit))) {
    throw new Error("Repository preparation requires a GitHub URL and a valid pinned commit");
  }
  const assertAgent = params.assertCurrent;
  const assertAgentPrepared = async () => params.assertCurrent();
  const assertCaller = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
  };
  const assertAdmission = assertCaller;
  const repositoryPath = new URL(url).pathname.replace(/\.git$/u, "");
  const prepareIdentity = async (assertPreparationCurrent: () => void) => {
    await assertAgentPrepared();
    assertPreparationCurrent();
    const config = getConfig();
    const identity = await prepareGitHubReadIdentity({
      config,
      sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
      agentId: request.agentId,
      getCurrentConfig: getConfig,
      assertActive:
        params.readCredential || params.retainCredentialCleanup ? assertAdmission : assertAgent,
      readNativeCredential: params.readCredential,
      allowAppInstallation: params.retainCredentialCleanup !== undefined,
      requestedRepository: repositoryPath.slice(1),
      refresh: () => refresh(request.agentId),
      allowAnonymous: true,
    }).catch(async (error: unknown) => {
      await assertAgentPrepared();
      // Native credential subprocess diagnostics must never enter provider errors.
      throw error instanceof GitHubIdentityError ? error : new GitHubIdentityError("unverified");
    });
    if (identity.revoke) {
      params.retainCredentialCleanup?.(identity.revoke);
    }
    assertPreparationCurrent();
    assertAgent();
    return identity;
  };
  await assertAgentPrepared();
  assertAdmission();
  let identity = await prepareIdentity(assertCaller);
  assertAdmission();
  const owner = { identity: recordedIdentity(identity.selection) };
  if (expected && JSON.stringify(owner.identity) !== expected.identityKey) {
    sourceChanged();
  }
  const assertCurrent = () => {
    assertAgent();
    identity.assertSelected();
  };
  const endpoint = `${gitHubPublicApi.GITHUB_API_BASE_URL}/repos${repositoryPath}`;
  const read = async (
    suffix: string,
    readIdentity: typeof identity,
    assertOwner: () => void,
    signal?: AbortSignal,
    graphql?: { query: string; variables: Record<string, string> },
  ): Promise<unknown> => {
    assertOwner();
    const response = await gitHubPublicApi.fetchGitHubApi(
      graphql ? gitHubPublicApi.GITHUB_GRAPHQL_URL : endpoint + suffix,
      fetch,
      readIdentity.token,
      async () => sourceChanged(),
      readIdentity,
      undefined,
      signal,
      graphql,
    );
    let value: unknown;
    try {
      assertOwner();
      value =
        graphql && readIdentity.token
          ? await gitHubPublicApi.readGitHubGraphQLResponse(
              response,
              fetch,
              readIdentity.token,
              METADATA_MAX_BYTES,
            )
          : await gitHubPublicApi.readGitHubJsonResponse(response, METADATA_MAX_BYTES);
    } finally {
      await gitHubPublicApi.discardResponse(response);
    }
    await readIdentity.revalidate();
    assertOwner();
    return value;
  };
  const repositoryMetadata = (value: unknown, readIdentity: typeof identity) => {
    if (
      !isRecord(value) ||
      typeof value.node_id !== "string" ||
      !/^[A-Za-z0-9_+/=-]{1,256}$/u.test(value.node_id) ||
      typeof value.clone_url !== "string" ||
      parseProjectGitUrl(value.clone_url, resolveConfiguredGitHubHost(getConfig()))?.url !== url ||
      typeof value.private !== "boolean" ||
      (value.private && (readIdentity.selection.source === "anonymous" || !readIdentity.token))
    ) {
      sourceChanged();
    }
    return {
      repositoryId: value.node_id,
      defaultBranch: value.default_branch,
      private: value.private,
    };
  };
  const readRepository = async (
    readIdentity: typeof identity,
    assertOwner: () => void,
    signal?: AbortSignal,
  ) => repositoryMetadata(await read("", readIdentity, assertOwner, signal), readIdentity);
  const readPinnedRepository = async (
    repositoryId: string,
    baseCommit: string,
    readIdentity: typeof identity,
    assertOwner: () => void,
    signal?: AbortSignal,
  ) => {
    if (!readIdentity.token) {
      return undefined;
    }
    let value: unknown;
    try {
      value = await read("", readIdentity, assertOwner, signal, {
        query: PINNED_REPOSITORY_QUERY,
        variables: { repositoryId, commit: baseCommit },
      });
    } catch (error) {
      // Native classic tokens can read public REST metadata without the
      // public_repo scope required by GraphQL. Preserve the full REST fence.
      if (!(error instanceof gitHubPublicApi.GitHubGraphQLUnavailableError)) {
        throw error;
      }
      await readIdentity.revalidate();
      assertOwner();
      return undefined;
    }
    const node = isRecord(value) && isRecord(value.data) ? value.data.node : undefined;
    if (!isRecord(node) || node.__typename !== "Repository" || node.node_id !== repositoryId) {
      sourceChanged();
    }
    const metadata = repositoryMetadata(node, readIdentity);
    const commit = node.object;
    // Missing objects return null without GraphQL errors, including absent SHAs.
    if (!isRecord(commit) || commit.__typename !== "Commit" || objectSha(commit) !== baseCommit) {
      sourceChanged();
    }
    objectSha(commit.tree);
    return { metadata, commit };
  };
  const pinnedRepository =
    expected && request.baseCommit
      ? await readPinnedRepository(
          expected.repositoryId,
          request.baseCommit,
          identity,
          assertAdmission,
          params.signal,
        )
      : undefined;
  const metadata =
    pinnedRepository?.metadata ?? (await readRepository(identity, assertAdmission, params.signal));
  const repositoryId = metadata.repositoryId;
  if (expected && repositoryId !== expected.repositoryId) {
    sourceChanged();
  }
  const requestedRef =
    request.ref === undefined || request.ref === "HEAD"
      ? typeof metadata.defaultBranch === "string"
        ? `heads/${metadata.defaultBranch}`
        : ""
      : request.ref.replace(/^refs\/(?=heads\/|tags\/)/u, "");
  if (
    !request.baseCommit &&
    (!requestedRef || requestedRef.length > 1024 || /\p{Cc}/u.test(requestedRef))
  ) {
    throw new Error("GitHub repository has no valid source reference; select a branch or commit.");
  }
  const pinned = request.baseCommit ?? (GitObject.test(requestedRef) ? requestedRef : undefined);
  const commit =
    pinnedRepository?.commit ??
    (await read(
      pinned ? `/git/commits/${pinned}` : `/commits/${encodeURIComponent(requestedRef)}?per_page=1`,
      identity,
      assertAdmission,
      params.signal,
    ));
  const baseCommit = objectSha(commit);
  if (pinned && baseCommit !== pinned) {
    sourceChanged();
  }
  const requiresGitPack = metadata.private || new URL(url).hostname !== "github.com";
  const tree = objectSha(
    pinned
      ? isRecord(commit)
        ? commit.tree
        : undefined
      : isRecord(commit) && isRecord(commit.commit)
        ? commit.commit.tree
        : undefined,
  );
  const readTree = async (sha: string, signal?: AbortSignal) => {
    const value = await read(`/git/trees/${sha}`, identity, assertCurrent, signal);
    if (
      !isRecord(value) ||
      objectSha(value) !== sha ||
      value.truncated !== false ||
      !Array.isArray(value.tree)
    ) {
      throw new Error(
        "GitHub tree metadata is incomplete; retry preparation with a complete source.",
      );
    }
    return value.tree.filter(isRecord);
  };
  // The host resolves recipe facts first, then confirms this repository instance
  // before advertising reusable capacity. Later lease revalidation is independent.
  const confirmAdmission = async () => {
    const confirmed = await readRepository(identity, assertAdmission, params.signal);
    if (confirmed.private !== metadata.private || confirmed.repositoryId !== repositoryId) {
      sourceChanged();
    }
    assertAdmission();
  };
  const revalidate = async (signal?: AbortSignal) => {
    const assertSource = () => {
      signal?.throwIfAborted();
      assertCurrent();
    };
    assertSource();
    const current = await prepareIdentity(() => signal?.throwIfAborted());
    assertSource();
    if (!isDeepStrictEqual(recordedIdentity(current.selection), owner.identity)) {
      sourceChanged();
    }
    const currentPinnedRepository = await readPinnedRepository(
      repositoryId,
      baseCommit,
      current,
      assertSource,
      signal,
    );
    const before =
      currentPinnedRepository?.metadata ?? (await readRepository(current, assertSource, signal));
    if (before.private !== metadata.private || before.repositoryId !== repositoryId) {
      sourceChanged();
    }
    const observed =
      currentPinnedRepository?.commit ??
      (await read(`/git/commits/${baseCommit}`, current, assertSource, signal));
    if (
      objectSha(observed) !== baseCommit ||
      (currentPinnedRepository && objectSha(currentPinnedRepository.commit.tree) !== tree)
    ) {
      sourceChanged();
    }
    const after = await readRepository(current, assertSource, signal);
    if (after.private !== metadata.private || after.repositoryId !== repositoryId) {
      sourceChanged();
    }
    assertSource();
    identity = current;
  };
  return {
    repositoryId,
    identityKey: JSON.stringify(owner.identity),
    private: metadata.private,
    baseCommit,
    tree,
    async readTree(sha, signal) {
      const entries = await readTree(sha, signal);
      return entries.flatMap((entry) => {
        if (
          typeof entry.path !== "string" ||
          typeof entry.mode !== "string" ||
          (entry.type !== "tree" && entry.type !== "blob")
        ) {
          return [];
        }
        return [{ path: entry.path, mode: entry.mode, type: entry.type, sha: objectSha(entry) }];
      });
    },
    async readBlob(blob, signal) {
      const value = await read(`/git/blobs/${blob}`, identity, assertCurrent, signal);
      if (
        !isRecord(value) ||
        objectSha(value) !== blob ||
        value.encoding !== "base64" ||
        typeof value.content !== "string" ||
        typeof value.size !== "number" ||
        value.size < 0 ||
        value.size > METADATA_MAX_BYTES
      ) {
        throw new Error("GitHub returned invalid environment recipe content; retry preparation.");
      }
      const decoded = Buffer.from(value.content, "base64");
      if (decoded.length !== value.size || decoded.length > METADATA_MAX_BYTES) {
        throw new Error(
          "GitHub returned incomplete environment recipe content; retry preparation.",
        );
      }
      return decoded.toString("utf8");
    },
    assertCurrent,
    confirmAdmission,
    revalidate,
    ...(requiresGitPack
      ? {
          prepareGitPack: async (input: {
            temporaryRoot: string;
            signal: AbortSignal;
            assertCurrent: () => void;
          }) => {
            const assertFetchCurrent = () => {
              input.signal.throwIfAborted();
              input.assertCurrent();
              assertCurrent();
            };
            // The host revalidates the lease around this transport; retain the
            // selected credential's own assertion at the Git effect boundary.
            assertFetchCurrent();
            const readIdentity = identity;
            const token = readIdentity.token;
            const pack = await prepareRepositoryCheckoutPack({
              ...input,
              url,
              baseCommit,
              ...(token
                ? {
                    httpAuthorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
                  }
                : {}),
              assertCurrent: () => {
                assertFetchCurrent();
                readIdentity.assertSelected();
              },
            });
            assertFetchCurrent();
            return pack;
          },
        }
      : {}),
  };
}

export function createGitHubWorkerSource(
  getConfig: () => OpenClawConfig,
  refresh: (agentId: string) => Promise<void>,
): RepositoryWorkerSource {
  const prepareRead = async (
    agentId: string,
    assertCurrent: () => void,
    credential?: Pick<
      Parameters<RepositoryWorkerSource["checkout"]>[0],
      "url" | "readCredential" | "retainCredentialCleanup"
    >,
  ) => {
    const config = getConfig();
    const identity = await prepareGitHubReadIdentity({
      config,
      sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
      agentId,
      getCurrentConfig: getConfig,
      assertActive: assertCurrent,
      readNativeCredential: credential?.readCredential,
      allowAppInstallation: credential?.retainCredentialCleanup !== undefined,
      requestedRepository: credential
        ? new URL(credential.url).pathname.replace(/^\/|\.git$/gu, "")
        : undefined,
      refresh: () => refresh(agentId),
      allowAnonymous: true,
    }).catch((error: unknown) => {
      assertCurrent();
      throw error instanceof GitHubIdentityError ? error : new GitHubIdentityError("unverified");
    });
    if (identity.revoke) {
      credential?.retainCredentialCleanup?.(identity.revoke);
    }
    assertCurrent();
    return identity;
  };
  return {
    isIdentityCurrent({ agentId, identityKey }) {
      let identity: unknown;
      try {
        identity = JSON.parse(identityKey);
      } catch {
        return false;
      }
      if (!isRecord(identity)) {
        return false;
      }
      const config = getConfig();
      const agent = resolveConfiguredGitHubToolIdentity({ config, agentId, scope: "agent" });
      const system = resolveConfiguredGitHubToolIdentity({ config, agentId, scope: "system" });
      const selected = agent ?? system;
      return selected
        ? identity.source === (agent ? "agent-override" : "system-configured") &&
            "profileId" in identity &&
            identity.profileId === selected.profileId
        : identity.source === "anonymous" || identity.source === "system-detected";
    },
    async restore(input) {
      const identity = await prepareRead(input.agentId, input.assertCurrent);
      const assertCurrent = () => {
        input.signal?.throwIfAborted();
        input.assertCurrent();
        identity.assertSelected();
      };
      assertCurrent();
      const options = { signal: input.signal, token: identity.token, assertCurrent };
      const project = await identity
        .start(() =>
          materializeProjectClone(
            {
              gitUrl: input.url,
              requiredCommit: input.requiredCommit,
            },
            options,
          ),
        )
        .catch((error: unknown) => {
          if (error instanceof ProjectCloneError && error.failure === "auth_required") {
            throw new ProjectCloneError(
              error.failure,
              "GitHub could not authenticate this repository with the selected shared GitHub identity. Check its repository access or reconnect it in Settings, then retry the Gateway move.",
            );
          }
          throw error;
        });
      assertCurrent();
      return {
        project: { id: project.id, repoRoot: project.repoRoot, source: project.source },
        assertCurrent,
        async readRemoteHead(branch) {
          assertCurrent();
          const head = await identity.start(() =>
            readProjectCheckoutRemoteHead(
              { url: input.url, target: project.repoRoot, branch },
              options,
            ),
          );
          assertCurrent();
          return head;
        },
      };
    },
    prepare: (input) => prepareGitHubWorkerSource(input, getConfig, refresh),
    async checkout(input) {
      const identity = await prepareRead(input.agentId, input.assertCurrent, input);
      input.assertCurrent();
      identity.assertSelected();
      await performRepositoryCheckout(input.transfer, {
        token: identity.token,
        assertCurrent: () => {
          input.assertCurrent();
          identity.assertSelected();
        },
        start: identity.start,
      });
    },
  };
}
