import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import type { CodexManagedThreadStore } from "./app-server/managed-thread-store.js";
import { assertCodexThreadForkParams } from "./app-server/protocol.js";
import type {
  CodexAppServerRequestParams,
  CodexAppServerRequestResult,
  CodexThread,
  CodexThreadForkParams,
  CodexThreadForkResponse,
  CodexThreadListParams,
  CodexThreadListResponse,
  CodexThreadItemsListParams,
  CodexThreadItemsListResponse,
  CodexThreadTurnsListParams,
  CodexThreadTurnsListResponse,
} from "./app-server/protocol.js";
import type { CodexControlRequestObservation } from "./app-server/request-observation.js";
import { withTimeout } from "./app-server/timeout.js";
import { CodexCatalogLoadingError } from "./session-catalog-availability.js";
import { requireEligibleCodexThread } from "./session-catalog-eligibility.js";
import type { CodexCatalogIndex } from "./session-catalog-index.js";
import {
  currentCodexCatalogListRequest,
  withCodexCatalogListRequest,
  type CodexCatalogListRequest,
} from "./session-catalog-list-request.js";
import { readControlCursor, readPageParams } from "./session-catalog-parsing.js";
import type { CodexCatalogSourceBackoff } from "./session-catalog-source-backoff.js";
import type { CodexSessionCatalogControl } from "./session-catalog-types.js";

export type CodexSessionCatalogRequestSnapshot = {
  beginList: (request?: CodexCatalogListRequest) => ReturnType<CodexCatalogSourceBackoff["begin"]>;
  index: () => Promise<CodexCatalogIndex>;
  requestTimeoutMs: number;
  listThreads(
    params: CodexThreadListParams,
    timeoutMs: number,
    observation?: CodexControlRequestObservation,
  ): Promise<CodexThreadListResponse>;
  listThreadTurns(params: CodexThreadTurnsListParams): Promise<CodexThreadTurnsListResponse>;
  listThreadItems(params: CodexThreadItemsListParams): Promise<CodexThreadItemsListResponse>;
  forkThread(
    params: CodexThreadForkParams,
    assertCurrent?: () => void,
  ): Promise<CodexThreadForkResponse>;
  readThread(threadId: string, includeTurns: boolean, timeoutMs?: number): Promise<CodexThread>;
  archiveThread(threadId: string, assertCurrent?: () => void): Promise<void>;
};

type CodexCatalogRequestMethod =
  | typeof CODEX_CONTROL_METHODS.archiveThread
  | typeof CODEX_CONTROL_METHODS.forkThread
  | typeof CODEX_CONTROL_METHODS.listThreads
  | typeof CODEX_CONTROL_METHODS.listThreadTurns
  | typeof CODEX_CONTROL_METHODS.listThreadItems
  | typeof CODEX_CONTROL_METHODS.readThread;

type CodexCatalogRequest = <M extends CodexCatalogRequestMethod>(
  method: M,
  requestParams: CodexAppServerRequestParams<M>,
  timeoutMs?: number,
  assertCurrent?: () => void,
  observation?: CodexControlRequestObservation,
) => Promise<CodexAppServerRequestResult<M>>;

export function createCodexCatalogRequestSnapshot(
  requestTimeoutMs: number,
  request: CodexCatalogRequest,
  index: () => Promise<CodexCatalogIndex>,
  beginList: CodexSessionCatalogRequestSnapshot["beginList"],
  catalogRead = false,
): CodexSessionCatalogRequestSnapshot {
  const read = <M extends CodexCatalogRequestMethod>(
    method: M,
    params: CodexAppServerRequestParams<M>,
    timeoutMs?: number,
    observation?: CodexControlRequestObservation,
  ): Promise<CodexAppServerRequestResult<M>> => {
    // Index reads are charged by NativePages; hydration never borrows a caller's scope.
    const scope = catalogRead ? undefined : currentCodexCatalogListRequest();
    if (!scope) {
      return request(method, params, timeoutMs, undefined, observation);
    }
    return scope.read(timeoutMs ?? requestTimeoutMs, async (remaining) => {
      const attempt = beginList(scope);
      if (!attempt.allowed) {
        throw attempt.error;
      }
      return await request(method, params, remaining, undefined, observation);
    });
  };
  return {
    index,
    beginList,
    get requestTimeoutMs() {
      return catalogRead
        ? requestTimeoutMs
        : (currentCodexCatalogListRequest()?.remaining(requestTimeoutMs) ?? requestTimeoutMs);
    },
    listThreads: (params, timeoutMs, observation) =>
      read(CODEX_CONTROL_METHODS.listThreads, params, timeoutMs, observation),
    listThreadTurns: (params) => read(CODEX_CONTROL_METHODS.listThreadTurns, params),
    listThreadItems: (params) => read(CODEX_CONTROL_METHODS.listThreadItems, params),
    forkThread: (params, assertCurrent) =>
      request(
        CODEX_CONTROL_METHODS.forkThread,
        assertCodexThreadForkParams(params),
        undefined,
        assertCurrent,
      ),
    readThread: async (threadId, includeTurns, timeoutMs) =>
      (await read(CODEX_CONTROL_METHODS.readThread, { threadId, includeTurns }, timeoutMs)).thread,
    archiveThread: async (threadId, assertCurrent) => {
      await request(CODEX_CONTROL_METHODS.archiveThread, { threadId }, undefined, assertCurrent);
    },
  };
}

export function createCodexSessionCatalogControlFromRequests(params: {
  forkContext?: CodexSessionCatalogControl["forkContext"];
  clientId?: string;
  retireConnection?: () => void;
  connectionFingerprint?: string;
  createRequestSnapshot: () => CodexSessionCatalogRequestSnapshot;
  localSessionsRoot?: string;
  sourceHomeId?: string;
  managedThreads?: CodexManagedThreadStore;
  now: () => number;
  withPinnedConnection: CodexSessionCatalogControl["withPinnedConnection"];
}): CodexSessionCatalogControl {
  return {
    forkContext: params.forkContext,
    ...(params.clientId ? { clientId: params.clientId } : {}),
    ...(params.connectionFingerprint
      ? { connectionFingerprint: params.connectionFingerprint }
      : {}),
    withPinnedConnection: params.withPinnedConnection,
    async initialize() {
      await (await params.createRequestSnapshot().index()).initialize();
    },
    requireEligibleThread: (threadId) =>
      requireEligibleCodexThread({
        threadId,
        requests: params.createRequestSnapshot(),
        localSessionsRoot: params.localSessionsRoot,
        sourceHomeId: params.sourceHomeId,
        managedThreads: params.managedThreads,
        now: params.now,
      }),
    retireConnection: params.retireConnection,
    async listPage(pageParams) {
      readControlCursor(pageParams.cursor, "request");
      const query = readPageParams(pageParams);
      return await withCodexCatalogListRequest(async (request) => {
        const requests = params.createRequestSnapshot();
        // Release foreground admission while index-owned hydration continues.
        const timeoutMs = Math.min(requests.requestTimeoutMs, 5_000);
        const deadline = request.constrainDeadline(performance.now() + timeoutMs);
        const index = await withTimeout(
          requests.index(),
          request.remaining(timeoutMs),
          "Codex session catalog is still loading",
          () => new CodexCatalogLoadingError(),
        );
        return await index.list(query, deadline);
      });
    },
    async listDescendantPage(listParams) {
      const requests = params.createRequestSnapshot();
      return await requests.listThreads(listParams, requests.requestTimeoutMs);
    },
    async readThread(threadId, includeTurns = false) {
      return await params.createRequestSnapshot().readThread(threadId, includeTurns);
    },
    async listTurnPage(listParams) {
      return await params.createRequestSnapshot().listThreadTurns(listParams);
    },
    listItemPage: (listParams) => params.createRequestSnapshot().listThreadItems(listParams),
    async forkThread(forkParams, assertCurrent) {
      const requests = params.createRequestSnapshot();
      const index = forkParams.ephemeral === true ? undefined : await requests.index();
      const response = await requests.forkThread(forkParams, assertCurrent);
      if (index && !index.get(response.thread.id)) {
        await index.upsertThread(response.thread);
      }
      return response;
    },
    async archiveThread(threadId, assertCurrent) {
      const requests = params.createRequestSnapshot();
      const index = await requests.index();
      await requests.archiveThread(threadId, assertCurrent);
      index.archive(threadId);
    },
  };
}
