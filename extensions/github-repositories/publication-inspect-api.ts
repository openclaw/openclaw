import type { SessionGitHubPullRequestInspectResult } from "@openclaw/gateway-protocol";
import { GITHUB_PULL_REQUEST_LOGIN_PATTERN } from "@openclaw/gateway-protocol/schema";
import type { NativeGitHubPublicationOwnPullRequestReader as RepositoryPublicationOwnPullRequestReader } from "openclaw/plugin-sdk/native-github-publication-host";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { containsAsciiControlCharacter } from "openclaw/plugin-sdk/string-normalization-runtime";
import { readGitHubConfig } from "./config-api.js";
import { resolveConfiguredGitHubApiBaseUrl } from "./host-api.js";
import {
  currentGitHubPublicationConfig,
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
} from "./publication-availability-api.js";
import { createGitHubPublicationJsonReader } from "./publication-json-read-api.js";
type Inspection = SessionGitHubPullRequestInspectResult;
const unavailable = () =>
  new Error(
    "The PR could not be verified as yours with current repository access. Check its URL and your linked GitHub account.",
  );
const commitPattern = /^[a-f0-9]{40}$/u;
const loginPattern = new RegExp(GITHUB_PULL_REQUEST_LOGIN_PATTERN, "u");

function isGitHubLogin(value: string): boolean {
  return loginPattern.test(value);
}

function isRepositoryName(value: string): boolean {
  const [owner, name, extra] = value.split("/");
  return (
    owner !== undefined &&
    isGitHubLogin(owner) &&
    name !== undefined &&
    /^[A-Za-z0-9._-]{1,100}$/u.test(name) &&
    name !== "." &&
    name !== ".." &&
    !/\.(?:git|atom)$/iu.test(name) &&
    extra === undefined
  );
}

function parsePullRequestUrl(value: string, host: string) {
  const url = URL.parse(value);
  const match =
    url &&
    /^\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)(?:\/(?:changes|files|checks|commits(?:\/[a-f0-9]{40})?))?\/?$/u.exec(
      url.pathname,
    );
  let repository: string | undefined;
  try {
    repository = match ? decodeURIComponent(match[1]!) : undefined;
  } catch {
    repository = undefined;
  }
  const number = Number(match?.[2]);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.host !== host ||
    url.username ||
    url.password ||
    !repository ||
    !isRepositoryName(repository) ||
    !Number.isSafeInteger(number) ||
    number < 1
  ) {
    throw new Error(`Supply a pull request URL on the configured GitHub host (${host}).`);
  }
  return { repository, number };
}

function repositoryFacts(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    typeof value.full_name !== "string" ||
    !isRepositoryName(value.full_name) ||
    typeof value.private !== "boolean"
  ) {
    throw unavailable();
  }
  return {
    id: value.id,
    name: value.full_name,
    private: value.private,
  };
}

function refFacts(
  value: unknown,
  repository: ReturnType<typeof repositoryFacts>,
): Inspection["base"] {
  if (
    !isRecord(value) ||
    typeof value.ref !== "string" ||
    !value.ref ||
    value.ref.length > 256 ||
    containsAsciiControlCharacter(value.ref) ||
    value.ref.includes(" ") ||
    typeof value.sha !== "string" ||
    !commitPattern.test(value.sha) ||
    !isRecord(value.repo) ||
    value.repo.id !== repository.id ||
    value.repo.full_name !== repository.name
  ) {
    throw unavailable();
  }
  return {
    repository: repository.name,
    repositoryId: repository.id,
    branch: value.ref,
    commit: value.sha,
  };
}

export async function inspectOwnGitHubPullRequest(params: {
  pullRequestUrl: string;
  agentId: string;
  reader: RepositoryPublicationOwnPullRequestReader;
  assertCurrent: () => void;
}) {
  const inspected = await readOwnGitHubPullRequest(params);
  return {
    ...inspected,
    ...(inspected.ownPublication && params.reader.publication?.headCommit
      ? { publishedHeadCommit: params.reader.publication.headCommit }
      : {}),
  };
}

/** Read-only consumers retain linked ownership unless the action owner supplies full-write authority. */
export async function readOwnGitHubPullRequest(params: {
  pullRequestUrl: string;
  agentId: string;
  reader: RepositoryPublicationOwnPullRequestReader;
  assertCurrent: () => void;
}) {
  const { host, accountIds: admittedIds, publication, operatorWrite } = params.reader;
  const target = parsePullRequestUrl(params.pullRequestUrl, host);
  const publicContinuation = !operatorWrite && admittedIds.length === 0;
  if (
    publicContinuation &&
    publication?.url !== `https://${host}/${target.repository}/pull/${target.number}`
  ) {
    throw unavailable();
  }
  const assertRequester = () => {
    params.assertCurrent();
    params.reader.assertCurrent();
  };
  const identity = await prepareCurrentGitHubPublicationIdentity(params.agentId, assertRequester);
  const config = currentGitHubPublicationConfig();
  const apiBaseUrl = resolveConfiguredGitHubApiBaseUrl(config);
  const hasReadEndpoint =
    host === "github.com" || Boolean(readGitHubConfig(config).apiBaseUrl?.trim());
  const assertIdentityCurrent = () => {
    params.reader.assertCurrent();
    if (
      (identity.host ?? "github.com") !== host ||
      resolveConfiguredGitHubApiBaseUrl(currentGitHubPublicationConfig()) !== apiBaseUrl ||
      !matchesCurrentGitHubPublicationIdentity({ agentId: params.agentId, identity }) ||
      (publicContinuation &&
        (!publication ||
          !(
            publication.publisher.agentId === params.agentId &&
            publication.publisher.source === identity.source &&
            publication.publisher.profileId === (identity.profileId ?? null) &&
            publication.publisher.accountId === identity.account.accountId &&
            publication.publisher.login?.toLowerCase() === identity.account.login.toLowerCase()
          )))
    ) {
      throw new Error("The GitHub publisher changed; retry inspection.");
    }
  };
  const assertCurrent = () => {
    assertRequester();
    assertIdentityCurrent();
  };
  assertCurrent();
  const read = createGitHubPublicationJsonReader({
    host,
    env: identity.env,
    assertCurrent,
    unavailable,
    requireSuccess: false,
  });
  const hasAccess = async (repository: string, accountId: number, login: string) => {
    const permission = await read(
      `repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    return (
      isRecord(permission) &&
      isRecord(permission.user) &&
      permission.user.id === accountId &&
      ["read", "triage", "write", "maintain", "admin"].includes(String(permission.permission))
    );
  };
  const baseRepository = repositoryFacts(await read(`repos/${target.repository}`));
  // Shared reader access alone must never disclose a private PR's existence or author.
  const privateReaders = new Set<number>();
  if (baseRepository.private && !operatorWrite) {
    for (const accountId of admittedIds) {
      const user = await read(`user/${accountId}`);
      const login =
        isRecord(user) && typeof user.login === "string" && isGitHubLogin(user.login)
          ? user.login
          : undefined;
      if (
        isRecord(user) &&
        user.id === accountId &&
        login &&
        (await hasAccess(baseRepository.name, accountId, login))
      ) {
        privateReaders.add(accountId);
      }
    }
    if (!privateReaders.size) {
      throw unavailable();
    }
  }
  const pr = await read(`repos/${baseRepository.name}/pulls/${target.number}`);
  const ownPublication =
    publication !== undefined &&
    isRecord(pr) &&
    isRecord(pr.user) &&
    publication.url === pr.html_url &&
    publication.publisher.accountId === pr.user.id;
  if (
    !isRecord(pr) ||
    !isRecord(pr.user) ||
    typeof pr.user.id !== "number" ||
    (baseRepository.private &&
      !operatorWrite &&
      !privateReaders.has(pr.user.id) &&
      !ownPublication) ||
    typeof pr.user.login !== "string" ||
    !isGitHubLogin(pr.user.login) ||
    pr.number !== target.number ||
    pr.html_url !== `https://${host}/${baseRepository.name}/pull/${target.number}` ||
    (pr.state !== "open" && pr.state !== "closed") ||
    typeof pr.draft !== "boolean" ||
    typeof pr.merged !== "boolean" ||
    !isRecord(pr.head)
  ) {
    throw unavailable();
  }
  if (!operatorWrite && !admittedIds.includes(pr.user.id) && !ownPublication) {
    throw new Error(
      "This PR is not authored by a GitHub account linked to you. inspect_pr checks your PR authorship, not the managed publisher's credentials. For a new PR, use publish. A bot-authored PR from another session cannot be imported with inspect_pr or prepare_pr; continue it in the session that published it.",
    );
  }
  const base = refFacts(pr.base, baseRepository);
  let headRepository: ReturnType<typeof repositoryFacts> | undefined;
  if (pr.head.repo !== null) {
    const candidate = repositoryFacts(pr.head.repo);
    headRepository =
      candidate.id === baseRepository.id
        ? baseRepository
        : repositoryFacts(await read(`repos/${candidate.name}`));
    if (
      headRepository.id !== candidate.id ||
      headRepository.name !== candidate.name ||
      (publicContinuation && headRepository.private) ||
      (headRepository.private &&
        !operatorWrite &&
        headRepository.id !== baseRepository.id &&
        !(await hasAccess(headRepository.name, pr.user.id, pr.user.login)))
    ) {
      throw unavailable();
    }
  }
  const head = headRepository ? refFacts(pr.head, headRepository) : null;
  const result: Inspection = {
    url: pr.html_url,
    host,
    number: target.number,
    author: { accountId: pr.user.id, login: pr.user.login },
    state: pr.merged ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open",
    base,
    head,
  };
  assertCurrent();
  return {
    result,
    ownPublication,
    requirePublicRepositories: publicContinuation,
    assertCurrent,
    assertIdentityCurrent,
    details: pr,
    // Enterprise credentials must not inherit the public API's default destination.
    credential:
      identity.env.GH_TOKEN && hasReadEndpoint
        ? { token: identity.env.GH_TOKEN, apiBaseUrl, assertCurrent: assertIdentityCurrent }
        : undefined,
  };
}
