import { beforeEach, describe, expect, it, vi } from "vitest";
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

const { readSessionEntryFromStore, resolveSessionStorePathForAcp } =
  await import("./session-meta-store.js");

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
const readGlobal = (cfg = explicitFleet(), agentId?: string) =>
  readSessionEntryFromStore({ cfg, agentId, sessionKey: "global" });

describe("ACP session metadata store ownership", () => {
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
    expect(() =>
      readSessionEntryFromStore({
        cfg: explicitFleet(),
        sessionKey: "agent:ops:dashboard:incognito-read",
      }),
    ).toThrow(error);
  });

  it("returns a typed selection error for an ownerless bare key", () => {
    expect(() => readGlobal()).toThrowError(selectionError);
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

    expect(readGlobal(cfg)).toMatchObject({
      agentId: "ops",
      storePath: "/stores/ops.json",
      entry: { sessionId: "ops-session" },
    });
    expect(mocks.loadSessionEntryReadOnly).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "ops", storePath: "/stores/ops.json" }),
    );
  });

  it("returns a typed selection error when the persisted fixed-store owner is retired", () => {
    const cfg = explicitFleet("retired");
    expect(() => readGlobal(cfg)).toThrowError(selectionError);
    expect(() => readGlobal(cfg, "research")).toThrowError(selectionError);
    expect(mocks.loadSessionEntryReadOnly).not.toHaveBeenCalled();
  });

  it("rejects a supplied agent that conflicts with an agent-qualified key", () => {
    expect(() =>
      resolveSessionStorePathForAcp({
        cfg: explicitFleet(),
        agentId: "ops",
        sessionKey: "agent:research:work",
      }),
    ).toThrowError(selectionError);
  });
});
