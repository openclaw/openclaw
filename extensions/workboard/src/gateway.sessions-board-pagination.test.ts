import { expect, it } from "vitest";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { startEmptySessionsBoardService } from "./test/sessions-board.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

it("bounds Sessions board read and move responses and rejects a retired cursor visibly", async () => {
  const store = createWorkboardSqliteTestStore();
  const sessionsBoard = await startEmptySessionsBoardService(store);
  await store.upsertBoard({ id: "sessions", kind: "sessions" });
  const full = await sessionsBoard.read("sessions");
  full.sessions = Array.from({ length: 205 }, (_, index) => ({
    key: `agent:main:session-${index}`,
    sessionId: `session-${index}`,
    agentId: "main",
    run: "idle" as const,
    pullRequests: [],
    archived: false,
    lastActivityAt: index,
    columnId: "done",
    source: "state" as const,
    reason: "Idle",
  }));
  const { api, invoke } = createGatewayMethodCapture();
  registerWorkboardGatewayMethods({
    api,
    store,
    sessionsBoard: {
      read: async () => full,
      move: async () => full,
      update: sessionsBoard.update,
    },
  });
  const first = (await invoke("workboard.sessionsBoard.read", { boardId: "sessions" })).mock
    .calls[0]?.[1];
  expect(first.sessions).toHaveLength(100);
  expect(first.total).toBe(205);
  expect(first.nextCursor).toBe("agent:main:session-99");
  const second = (
    await invoke("workboard.sessionsBoard.read", {
      boardId: "sessions",
      after: first.nextCursor,
      sinceRevision: first.revision,
    })
  ).mock.calls[0]?.[1];
  expect(second.sessions).toHaveLength(100);
  expect(second.sessions[0].key).toBe("agent:main:session-100");
  const last = (
    await invoke("workboard.sessionsBoard.read", {
      boardId: "sessions",
      after: second.nextCursor,
    })
  ).mock.calls[0]?.[1];
  expect(last.sessions).toHaveLength(5);
  expect(last.nextCursor).toBeUndefined();
  const moved = (
    await invoke("workboard.sessionsBoard.move", {
      boardId: "sessions",
      sessionKey: "agent:main:session-204",
      columnId: "working",
    })
  ).mock.calls[0]?.[1];
  expect(moved.sessions).toHaveLength(100);
  const retired = await invoke("workboard.sessionsBoard.read", {
    boardId: "sessions",
    after: "deleted",
  });
  expect(retired.mock.calls[0]?.[0]).toBe(false);
  expect(retired.mock.calls[0]?.[2].message).toContain("Refresh the board");
  await sessionsBoard.stop();
});
