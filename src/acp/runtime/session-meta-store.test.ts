import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  IncognitoSessionEndedError,
  IncognitoSessionSyncAccessError,
} from "../../state/incognito-session-error.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntryReadOnly: vi.fn(),
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntryReadOnly: mocks.loadSessionEntryReadOnly,
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: (_store: string | undefined, params: { agentId?: string }) =>
    `/stores/${params.agentId ?? "main"}.json`,
}));

const { readSessionEntryFromStore } = await import("./session-meta-store.js");

function explicitFleet(owner?: string): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      entries: { ops: {}, research: {} },
      ...(owner ? { defaults: { sessionStore: { agentId: owner } } } : {}),
    },
    ...(owner ? { session: { store: "/stores/shared.sqlite" } } : {}),
  };
}

const selectionError = expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" });
const read = (cfg = explicitFleet(), agentId?: string, sessionKey = "global") =>
  readSessionEntryFromStore({ cfg, agentId, sessionKey });

beforeEach(() => {
  mocks.loadSessionEntryReadOnly.mockReset();
});

it.each([
  new IncognitoSessionSyncAccessError("readAcpSessionEntry", "readAcpSessionEntryAsync"),
  new AggregateError([new IncognitoSessionEndedError()], "Session read failed"),
])("propagates incognito refusal instead of reporting an unreadable store: %s", (error) => {
  mocks.loadSessionEntryReadOnly.mockImplementation(() => {
    throw error;
  });
  expect(() => read(explicitFleet(), undefined, "agent:ops:dashboard:incognito-read")).toThrow(
    error,
  );
});

it.each([
  ["ownerless", explicitFleet(), undefined, "global"],
  ["retired", explicitFleet("retired"), undefined, "global"],
  ["retired with explicit agent", explicitFleet("retired"), "research", "global"],
  ["conflicting agent", explicitFleet(), "ops", "agent:research:work"],
] as const)("rejects %s selection before reading", (_name, cfg, agentId, key) => {
  expect(() => read(cfg, agentId, key)).toThrowError(selectionError);
  expect(mocks.loadSessionEntryReadOnly).not.toHaveBeenCalled();
});

it.each(["persisted", "sole"] as const)("reads the %s owner's global session", (owner) => {
  const cfg =
    owner === "persisted"
      ? explicitFleet("ops")
      : ({
          session: { store: "/stores/shared.sqlite" },
          agents: { ownership: "explicit", entries: { ops: {} } },
        } satisfies OpenClawConfig);
  mocks.loadSessionEntryReadOnly.mockReturnValue({ sessionId: "ops-session" });

  expect(read(cfg)).toMatchObject({
    agentId: "ops",
    storePath: "/stores/ops.json",
    entry: { sessionId: "ops-session" },
  });
  expect(mocks.loadSessionEntryReadOnly).toHaveBeenCalledWith(
    expect.objectContaining({ agentId: "ops", storePath: "/stores/ops.json" }),
  );
});
