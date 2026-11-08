import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getChildLogger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { vi } from "vitest";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import type { GroupHistoryEntry } from "./inbound-context.js";
import { createWebOnMessageHandler } from "./on-message.js";
import { processMessage } from "./process-message.js";

vi.mock("./process-message.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./process-message.js")>()),
  processMessage: vi.fn(async () => true),
}));
vi.mock("./last-route.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./last-route.js")>()),
  updateLastRouteInBackground: vi.fn(),
}));
vi.mock("./ack-reaction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ack-reaction.js")>()),
  maybeSendAckReaction: vi.fn(async () => null),
}));
vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  logVerbose: vi.fn(),
}));

export function createGroupGatingTestHandler(params: {
  cfg: OpenClawConfig;
  groupHistories?: Map<string, GroupHistoryEntry[]>;
  warn?: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
}) {
  const groupHistories = params.groupHistories ?? new Map<string, GroupHistoryEntry[]>();
  const warn = params.warn ?? vi.fn();
  const processMock = vi.mocked(processMessage);
  const verboseMock = vi.mocked(logVerbose);
  processMock.mockClear();
  verboseMock.mockClear();
  const replyLogger = getChildLogger({ name: "whatsapp-group-admission-test" });
  vi.spyOn(replyLogger, "warn").mockImplementation((...args) => {
    warn(...args);
    return undefined;
  });
  const handler = createWebOnMessageHandler({
    cfg: params.cfg,
    verbose: false,
    connectionId: "group-admission-test",
    maxMediaBytes: 1024,
    groupHistoryLimit: 20,
    groupHistories,
    groupMemberNames: new Map(),
    backgroundTasks: new Set(),
    replyResolver: vi.fn(async () => undefined),
    replyLogger,
  });
  return { handler, groupHistories, processMock, verboseMock, warn };
}

export async function runGroupGatingTestMessage(params: {
  cfg: OpenClawConfig;
  msg: AdmittedWebInboundMessage;
}) {
  const fixture = createGroupGatingTestHandler(params);
  await fixture.handler(params.msg);
  return {
    result: { shouldProcess: fixture.processMock.mock.calls.length > 0 },
    groupHistories: fixture.groupHistories,
    verboseLogs: fixture.verboseMock.mock.calls.map(([message]) => message),
  };
}
