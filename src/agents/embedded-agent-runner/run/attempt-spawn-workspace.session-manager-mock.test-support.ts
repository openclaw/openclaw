import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { Mock } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;

export type SessionManagerMocks = {
  getSessionTarget: Mock<() => undefined>;
  getSessionId: Mock<() => string>;
  getAppendParentId: Mock<() => string | null>;
  getHeader: UnknownMock;
  getLeafId: Mock<() => string | null>;
  getLeafEntry: UnknownMock;
  getEntry: UnknownMock;
  getEntries: UnknownMock;
  getBranch: UnknownMock;
  getToolResultProjectionEntries: UnknownMock;
  getBoundaryCount: UnknownMock;
  branchAsync: UnknownMock;
  resetLeafAsync: UnknownMock;
  buildSessionContext: Mock<() => { messages: AgentMessage[] }>;
  appendThinkingLevelChange: UnknownMock;
  appendModelChange: UnknownMock;
  appendCustomEntryAsync: UnknownMock;
  appendMessageAsync: UnknownMock;
  appendSessionInfoAsync: UnknownMock;
  appendLabelChangeAsync: UnknownMock;
  flushPendingPersistence: UnknownMock;
  flushPendingToolResultsAsync: UnknownMock;
  clearPendingToolResults: UnknownMock;
  reloadPersistedTranscriptAsync: UnknownMock;
  setNextUserMessagePersistence: UnknownMock;
  removeTrailingEntriesAsync: UnknownMock;
};

export function readMockSessionCacheTtlTimestamp(
  sessionManager: {
    appendCustomEntryAsync?: { mock?: { calls?: unknown[][] } };
  },
  context?: { provider?: string; modelId?: string },
): number | null {
  const calls = sessionManager.appendCustomEntryAsync?.mock?.calls ?? [];
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const [customType, data] = calls[index] ?? [];
    if (customType !== "openclaw.cache-ttl") {
      continue;
    }
    const entry = asOptionalObjectRecord(data);
    if (
      context?.provider &&
      normalizeOptionalLowercaseString(entry?.provider) !==
        normalizeOptionalLowercaseString(context.provider)
    ) {
      continue;
    }
    if (
      context?.modelId &&
      normalizeOptionalLowercaseString(entry?.modelId) !==
        normalizeOptionalLowercaseString(context.modelId)
    ) {
      continue;
    }
    const timestamp = entry?.timestamp;
    return typeof timestamp === "number" ? timestamp : null;
  }
  return null;
}

export function resetSessionManagerMocks(
  sessionManager: SessionManagerMocks,
  messages: AgentMessage[] = [],
): void {
  sessionManager.getSessionTarget.mockReset().mockReturnValue(undefined);
  sessionManager.getSessionId.mockReset().mockReturnValue("embedded-session");
  sessionManager.getAppendParentId.mockReset().mockReturnValue(null);
  sessionManager.getHeader.mockReset().mockReturnValue({ version: 3 });
  sessionManager.getLeafId.mockReset().mockReturnValue(null);
  sessionManager.getLeafEntry.mockReset().mockReturnValue(null);
  sessionManager.getEntry.mockReset().mockReturnValue(undefined);
  sessionManager.getEntries.mockReset().mockReturnValue([]);
  sessionManager.getBranch.mockReset().mockReturnValue([]);
  sessionManager.getBoundaryCount.mockReset().mockReturnValue(0);
  sessionManager.branchAsync.mockReset();
  sessionManager.resetLeafAsync.mockReset();
  sessionManager.setNextUserMessagePersistence.mockReset();
  sessionManager.buildSessionContext.mockReset().mockReturnValue({ messages });
  sessionManager.appendThinkingLevelChange.mockReset();
  sessionManager.appendModelChange.mockReset();
  sessionManager.appendCustomEntryAsync.mockReset();
  sessionManager.appendMessageAsync.mockReset();
  sessionManager.appendSessionInfoAsync.mockReset();
  sessionManager.appendLabelChangeAsync.mockReset();
  sessionManager.flushPendingPersistence.mockReset();
  sessionManager.reloadPersistedTranscriptAsync.mockReset();
}
