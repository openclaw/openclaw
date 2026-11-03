import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  NativeGitHubSessionReads,
  PreparedNativeGitHubSessionRead,
  RepositorySessionObservation,
  RepositorySessionSourceScope,
} from "openclaw/plugin-sdk/native-github-session-read";
import {
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { onTestFinished, vi } from "vitest";
import * as preparedReadRuntime from "./control-ui-session-pr-prepared-read-api.js";
import {
  repositorySessionPrTarget,
  type ControlUiSessionPrTarget,
} from "./control-ui-session-pr-read-api.js";
import { createControlUiSessionPullRequestSubscriptions } from "./control-ui-session-pr-subscriptions-api.js";

const nativeLoadSessionPullRequests = preparedReadRuntime.loadSessionPullRequests;
export type SessionPrLoader = typeof nativeLoadSessionPullRequests;
let nextSource = 0;
/** Cache/scheduler units model source facts; native integration suites retain physical custody. */
export function createTestSessionPrReadSource() {
  return { agentId: "main", path: `fixture-source-${++nextSource}` };
}
export type TestSessionPrTarget = Partial<ControlUiSessionPrTarget> &
  Pick<ControlUiSessionPrTarget, "identity" | "params" | "source"> & {
    readSource?: { agentId: string; path: string };
  };

export function spyOnSessionPrLoader(load: SessionPrLoader = nativeLoadSessionPullRequests) {
  const loader = vi.spyOn(preparedReadRuntime, "loadSessionPullRequests").mockImplementation(load);
  onTestFinished(() => loader.mockRestore());
  return loader;
}

type Options = {
  scheduler: ReturnType<typeof createTestGatewayScheduler>;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: Set<string>,
    scope?: { sessionKeys: string[]; agentId: string },
  ) => void;
  isConnectionActive?: (connId: string) => boolean;
  prepareRead?: (
    connId: string,
    session: { sessionKey: string; agentId?: string },
  ) => Promise<(() => Promise<TestSessionPrTarget | undefined>) | undefined>;
  load?: SessionPrLoader;
  getConfig?: () => OpenClawConfig;
};

export function createTestControlUiSessionPrSubscriptions(options: Options) {
  const { scheduler, getConfig = () => ({}) } = options;
  if (options.load) {
    spyOnSessionPrLoader(options.load);
  }
  const sources = new WeakMap<RepositorySessionObservation, PreparedNativeGitHubSessionRead>();
  const source = createTestSessionPrReadSource();
  const normalize = (input: TestSessionPrTarget): ControlUiSessionPrTarget => {
    if (
      input.read &&
      input.observation &&
      input.sessionId &&
      input.branchIdentity &&
      input.githubHost &&
      input.refreshIndex !== undefined &&
      input.includesTaskPublications !== undefined
    ) {
      sources.set(input.observation, input.read);
      return { ...repositorySessionPrTarget(input.read, getConfig(), input.read), ...input };
    }
    const readSource = input.readSource ?? source;
    const selected: PreparedNativeGitHubSessionRead = {
      session: {
        sessionId: input.sessionId ?? input.identity,
        sessionKey: input.params.sessionKey,
        agentId: input.params.agentId,
      },
      source: typeof input.source === "string" ? { kind: "checkout", root: input.source } : null,
      identity: input.identity,
      branchIdentity: input.branchIdentity ?? input.identity,
      refreshIndex: false,
      includesTaskPublications: false,
      assertCurrent() {},
      async withSource(run) {
        let active = true;
        const assertCurrent = () => {
          if (!active) {
            throw new Error("Session PR source changed or closed. Retry the request.");
          }
        };
        const scope: RepositorySessionSourceScope = {
          identity: JSON.stringify([readSource.agentId, readSource.path]),
          assertCurrent,
          async readCheckoutRevision() {
            assertCurrent();
            return null;
          },
          async readCheckoutFacts() {
            assertCurrent();
            return undefined;
          },
          async readCheckoutBranchFacts() {
            assertCurrent();
            return undefined;
          },
        };
        try {
          return await run(scope);
        } finally {
          active = false;
        }
      },
      async readTaskPublications() {
        return { receipts: [], count: 0, branchMatchCount: 0 };
      },
    };
    const prepared: PreparedNativeGitHubSessionRead = {
      ...selected,
      viewerProfileId: input.ownGitHubProfileId,
      ownGitHubIdentity: input.ownGitHubIdentity,
      boundPullRequest: input.githubPullRequest,
      assertCurrent: input.assertCurrent ?? (() => {}),
    };
    sources.set(prepared, selected);
    const target = repositorySessionPrTarget(prepared, getConfig(), prepared);
    return {
      ...target,
      ...input,
      identity: target.identity,
      branchIdentity: target.branchIdentity,
      read: prepared,
      observation: prepared,
    };
  };
  const reads: NativeGitHubSessionReads = {
    runDetached: (run) => run(),
    assertCurrent: () => scheduler.signal.throwIfAborted(),
    isViewerConnected: (connId) => options.isConnectionActive?.(connId) ?? true,
    invalidateViewer: (connId) =>
      options.broadcastToConnIds(
        "sessions.changed",
        { reason: "profile-identity" },
        new Set([connId]),
      ),
    publishReviewUpdates: (connIds, payload, session) =>
      options.broadcastToConnIds(
        "controlUi.sessionPullRequests.changed",
        payload,
        new Set(connIds),
        { sessionKeys: [session.sessionKey], agentId: session.agentId },
      ),
    createViewerRead(connId, session) {
      const selected = options.prepareRead
        ? options.prepareRead(connId, session)
        : Promise.resolve(async () => ({
            params: {
              ...session,
              agentId:
                session.agentId ?? parseAgentSessionKey(session.sessionKey)?.agentId ?? "main",
            },
            identity: JSON.stringify(session),
            source: null,
          }));
      return async () => {
        const read = await selected;
        const target = await read?.();
        return target ? normalize(target).read : undefined;
      };
    },
    prepareServiceRead: async () => undefined,
    withSource: async (observation, run) => {
      const selected = sources.get(observation);
      if (!selected) {
        throw new Error("Resource fixture source retired");
      }
      return selected.withSource(run);
    },
    invalidate() {},
    subscribeChanges: () => () => {},
    installPresentation: () => () => {},
  };
  const serviceScheduler = createTestPluginServiceScheduler(scheduler);
  const subscriptions = createControlUiSessionPullRequestSubscriptions({
    reads,
    scheduler: serviceScheduler,
    getConfig,
  });
  return {
    ...subscriptions,
    read: (target: TestSessionPrTarget, assertCurrent: () => void, projection?: "publication") =>
      subscriptions.read(normalize(target), assertCurrent, projection),
    readPrepared: (target: TestSessionPrTarget, admitLoad?: () => boolean) =>
      subscriptions.readPrepared(normalize(target), admitLoad),
    async stop() {
      await subscriptions.stop();
      await serviceScheduler.stop();
    },
  };
}
