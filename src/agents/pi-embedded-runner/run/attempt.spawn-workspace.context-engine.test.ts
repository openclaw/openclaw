import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  createSubscriptionMock,
  expectCalledWithSessionKey,
  getHoisted,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();

describe("runEmbeddedAttempt context engine sessionKey forwarding", () => {
  const tempPaths: string[] = [];
  const sessionKey = "agent:main:discord:channel:test-ctx-engine";

  beforeEach(() => {
    hoisted.createAgentSessionMock.mockReset();
    hoisted.sessionManagerOpenMock.mockReset().mockReturnValue(hoisted.sessionManager);
    hoisted.resolveSandboxContextMock.mockReset();
    hoisted.subscribeEmbeddedPiSessionMock.mockReset().mockImplementation(createSubscriptionMock);
    hoisted.runContextEngineMaintenanceMock.mockReset().mockResolvedValue(undefined);
    hoisted.acquireSessionWriteLockMock.mockReset().mockResolvedValue({
      release: async () => {},
    });
    hoisted.sessionManager.getLeafEntry.mockReset().mockReturnValue(null);
    hoisted.sessionManager.branch.mockReset();
    hoisted.sessionManager.resetLeaf.mockReset();
    hoisted.sessionManager.appendCustomEntry.mockReset();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
  });

  it("forwards sessionKey to bootstrap, assemble, and afterTurn", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const afterTurn = vi.fn(async (_params: { sessionKey?: string }) => {});

    const result = await createContextEngineAttemptRunner({
      contextEngine: {
        bootstrap,
        assemble,
        afterTurn,
      },
      sessionKey,
      tempPaths,
    });

    expect(result.promptError).toBeNull();
    expectCalledWithSessionKey(bootstrap, sessionKey);
    expectCalledWithSessionKey(assemble, sessionKey);
    expectCalledWithSessionKey(afterTurn, sessionKey);
  });

  it("forwards modelId to assemble", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();

    const result = await createContextEngineAttemptRunner({
      contextEngine: {
        bootstrap,
        assemble,
      },
      sessionKey,
      tempPaths,
    });

    expect(result.promptError).toBeNull();
    expect(assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-test",
      }),
    );
  });

  it("forwards sessionKey to ingestBatch when afterTurn is absent", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const ingestBatch = vi.fn(
      async (_params: { sessionKey?: string; messages: AgentMessage[] }) => ({ ingestedCount: 1 }),
    );

    const result = await createContextEngineAttemptRunner({
      contextEngine: {
        bootstrap,
        assemble,
        ingestBatch,
      },
      sessionKey,
      tempPaths,
    });

    expect(result.promptError).toBeNull();
    expectCalledWithSessionKey(ingestBatch, sessionKey);
  });

  it("forwards sessionKey to per-message ingest when ingestBatch is absent", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const ingest = vi.fn(async (_params: { sessionKey?: string; message: AgentMessage }) => ({
      ingested: true,
    }));

    const result = await createContextEngineAttemptRunner({
      contextEngine: {
        bootstrap,
        assemble,
        ingest,
      },
      sessionKey,
      tempPaths,
    });

    expect(result.promptError).toBeNull();
    expect(ingest).toHaveBeenCalled();
    expect(
      ingest.mock.calls.every((call) => {
        const params = call[0];
        return params.sessionKey === sessionKey;
      }),
    ).toBe(true);
  });

  it("skips maintenance when afterTurn fails", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const afterTurn = vi.fn(async () => {
      throw new Error("afterTurn failed");
    });

    const result = await createContextEngineAttemptRunner({
      contextEngine: {
        bootstrap,
        assemble,
        afterTurn,
      },
      sessionKey,
      tempPaths,
    });

    expect(result.promptError).toBeNull();
    expect(afterTurn).toHaveBeenCalled();
    expect(hoisted.runContextEngineMaintenanceMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "turn" }),
    );
  });

  it("runs startup maintenance for existing sessions even without bootstrap()", async () => {
    const { assemble } = createContextEngineBootstrapAndAssemble();

    const result = await createContextEngineAttemptRunner({
      contextEngine: {
        assemble,
        maintain: true,
      },
      sessionKey,
      tempPaths,
    });

    expect(result.promptError).toBeNull();
    expect(hoisted.runContextEngineMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "bootstrap" }),
    );
  });

  it("skips maintenance when ingestBatch fails", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const ingestBatch = vi.fn(async () => {
      throw new Error("ingestBatch failed");
    });

    const result = await createContextEngineAttemptRunner({
      contextEngine: {
        bootstrap,
        assemble,
        ingestBatch,
      },
      sessionKey,
      tempPaths,
    });

    expect(result.promptError).toBeNull();
    expect(ingestBatch).toHaveBeenCalled();
    expect(hoisted.runContextEngineMaintenanceMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "turn" }),
    );
  });
});
