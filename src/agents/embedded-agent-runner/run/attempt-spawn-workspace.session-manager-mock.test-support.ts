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
  getBoundaryCount: UnknownMock;
  branch: UnknownMock;
  resetLeaf: UnknownMock;
  buildSessionContext: Mock<() => { messages: AgentMessage[] }>;
  appendThinkingLevelChange: UnknownMock;
  appendModelChange: UnknownMock;
  appendCustomEntry: UnknownMock;
  appendMessage: UnknownMock;
  appendSessionInfo: UnknownMock;
  appendLabelChange: UnknownMock;
  flushPendingPersistence: UnknownMock;
  flushPendingToolResults: UnknownMock;
  clearPendingToolResults: UnknownMock;
  reloadPersistedTranscript: UnknownMock;
  clearNextUserMessagePersistenceSuppression: UnknownMock;
  removeTrailingEntries: UnknownMock;
};
