import type {
  CodexThread,
  CodexThreadListParams,
  CodexThreadListResponse,
} from "./app-server/protocol.js";
import type { CodexControlRequestObservation } from "./app-server/request-observation.js";
import type { CodexCatalogIndex } from "./session-catalog-index.js";
import type { CodexCatalogListRequest } from "./session-catalog-list-request.js";
import type { CodexCatalogSourceBackoff } from "./session-catalog-source-backoff.js";
import type { CodexSessionCatalogControl } from "./session-catalog-types.js";

export type CodexSessionCatalogRequestSnapshot = Pick<
  CodexSessionCatalogControl,
  "forkThread" | "archiveThread"
> & {
  beginList: (request?: CodexCatalogListRequest) => ReturnType<CodexCatalogSourceBackoff["begin"]>;
  index: () => Promise<CodexCatalogIndex>;
  requestTimeoutMs: number;
  listThreads(
    params: CodexThreadListParams,
    timeoutMs: number,
    observation?: CodexControlRequestObservation,
  ): Promise<CodexThreadListResponse>;
  listThreadTurns: CodexSessionCatalogControl["listTurnPage"];
  listThreadItems: CodexSessionCatalogControl["listItemPage"];
  readThread(threadId: string, includeTurns: boolean, timeoutMs?: number): Promise<CodexThread>;
};
