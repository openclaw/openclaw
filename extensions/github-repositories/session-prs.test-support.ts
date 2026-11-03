import type {
  PreparedNativeGitHubSessionRead,
  RepositorySessionSourceScope,
} from "openclaw/plugin-sdk/native-github-session-read";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  readRuntimeConfig,
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, vi } from "vitest";
import type { GitHubCheckoutContext } from "./control-ui-session-pr-checkout.js";
import {
  repositorySessionPrTarget,
  type ControlUiSessionPrTarget,
  type ControlUiSessionPrReadContext,
} from "./control-ui-session-pr-read-api.js";
import { loadControlUiSessionPullRequests as loadPrs } from "./control-ui-session-prs-api.js";

type PrRequest = Parameters<typeof loadPrs>[0];
type PrDeps = Omit<Parameters<typeof loadPrs>[1], "read"> & {
  resolveGitRoot?: (params: PrRequest) => Promise<string | null>;
  resolveGitContext?: (params: PrRequest) => Promise<GitHubCheckoutContext | null>;
};
type CheckoutFacts = NonNullable<
  Awaited<ReturnType<RepositorySessionSourceScope["readCheckoutFacts"]>>
>;
const reads: Array<[{ type: string; input: { root: string } }]> = [];
let checkout:
  | {
      revision: () => string | null;
      resolve?: (root: string) => CheckoutFacts | null;
      additions?: (root: string) => number;
      emptyFacts?: boolean;
    }
  | undefined;
export function resetLocalPrGitReads() {
  reads.length = 0;
  checkout = undefined;
}
export function localPrGitReads(type?: string) {
  return reads.filter(
    ([operation]) => (!type || operation.type === type) && operation.type !== "checkout.revision",
  );
}
export function mockPrCheckout(options: NonNullable<typeof checkout>) {
  checkout = options;
}

export function githubJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
export function requestUrl(input: RequestInfo | URL | undefined): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : (input?.url ?? "");
}
export function routedFetch(
  routes: Array<{ match: string; response: () => Response | Promise<Response> }>,
) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = requestUrl(input);
    const route = routes.find((candidate) => url.includes(candidate.match));
    if (!route) {
      throw new Error(`unexpected GitHub request: ${url}`);
    }
    return route.response();
  });
}
export function pullListItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 103469,
    title: "fix(macos): tighten the link-browser tab header",
    html_url: "https://github.com/openclaw/openclaw/pull/103469",
    state: "open",
    draft: false,
    merged_at: null,
    head: { sha: "a".repeat(40) },
    base: { ref: "main", repo: { name: "openclaw", owner: { login: "openclaw" } } },
    ...overrides,
  };
}
export const testGitContext = {
  owner: "openclaw",
  repo: "openclaw",
  branch: "claude/browser-tabs-tighter-header",
};
let nextFixture = 0;
export function createSessionPullRequestsFixture() {
  let namespace = "";
  const roots = new Map<string, string>();
  beforeEach(() => {
    namespace = `pr-unit-${++nextFixture}`;
    roots.clear();
    resetLocalPrGitReads();
    setRuntimeConfigSnapshot({});
  });
  afterEach(clearRuntimeConfigSnapshot);
  const canonical = (params: PrRequest) => {
    const parsed = parseAgentSessionKey(params.sessionKey);
    const agentId = params.agentId ?? parsed?.agentId ?? "main";
    const sessionKey = parsed?.rest === "global" ? "global" : params.sessionKey;
    return { ...params, sessionKey, agentId };
  };
  function target(params: ReturnType<typeof canonical>): ControlUiSessionPrTarget {
    const root = roots.get(params.sessionKey);
    const identity = JSON.stringify([namespace, params.agentId, params.sessionKey, root]);
    const read: PreparedNativeGitHubSessionRead = {
      session: {
        sessionId: `${namespace}:${params.sessionKey}`,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
      },
      source: root ? { kind: "checkout", root } : null,
      identity,
      branchIdentity: identity,
      refreshIndex: false,
      includesTaskPublications: false,
      assertCurrent() {},
      async readTaskPublications() {
        return { receipts: [], count: 0, branchMatchCount: 0 };
      },
      async withSource(run) {
        let active = true;
        const assertCurrent = () => {
          if (!active) {
            throw new Error("Fixture source scope retired");
          }
        };
        const record = (type: string) => {
          assertCurrent();
          if (root) {
            reads.push([{ type, input: { root } }]);
          }
        };
        const source: RepositorySessionSourceScope = {
          identity: namespace,
          assertCurrent,
          async readCheckoutRevision() {
            record("checkout.revision");
            return checkout?.revision() ?? null;
          },
          async readCheckoutFacts() {
            record("checkout.context");
            return root ? (checkout?.resolve?.(root) ?? undefined) : undefined;
          },
          async readCheckoutBranchFacts() {
            record("pull-request.branch-facts");
            if (!root || (checkout?.emptyFacts && !checkout.additions)) {
              return undefined;
            }
            const additions = checkout?.additions?.(root);
            return {
              creatable: true,
              stats: additions === undefined ? null : { additions, deletions: 0, changedFiles: 1 },
            };
          },
        };
        try {
          return await run(source);
        } finally {
          active = false;
        }
      },
    };
    return repositorySessionPrTarget(read, readRuntimeConfig(), read);
  }
  return {
    setCheckout(sessionKey: string, root: string) {
      roots.set(canonical({ sessionKey }).sessionKey, root);
    },
    prepareRead: async (_connId: string, session: PrRequest) => async () =>
      target(canonical(session)),
    async load(params: PrRequest, deps: PrDeps = {}): ReturnType<typeof loadPrs> {
      const selected = canonical(params);
      const { resolveGitRoot, resolveGitContext, ...ownerDeps } = deps;
      const requested = await resolveGitContext?.(params);
      const root = resolveGitRoot ? await resolveGitRoot(params) : requested?.root;
      if (typeof root === "string") {
        roots.set(selected.sessionKey, root);
      }
      const prepared = target(selected);
      const source = resolveGitContext
        ? (requested ?? null)
        : root === null
          ? null
          : prepared.source;
      return withTestSessionPrRead({ ...prepared, source }, (read) =>
        loadPrs(params, { ...ownerDeps, read }),
      );
    },
  };
}
export function withTestSessionPrRead<T>(
  target: ControlUiSessionPrTarget,
  operation: (read: ControlUiSessionPrReadContext) => Promise<T>,
): Promise<T> {
  if (!target.read) {
    throw new Error("Missing prepared fixture read");
  }
  return target.read.withSource((sourceScope) =>
    operation({
      target,
      sourceScope,
      sourceIdentity: sourceScope.identity,
      assertCurrent: sourceScope.assertCurrent,
    }),
  );
}
