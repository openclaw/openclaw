import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  WorkboardSessionsBoard,
  WorkboardSessionsBoardRead,
} from "@openclaw/workboard-contract";
import type { ControlUiAgentPickerProps } from "openclaw/plugin-sdk/control-ui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountPage } from "./workboard-page.test-support.ts";

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

it("forwards the agent filter in sessionsBoard.read and places pagination below the board", async () => {
  const board: WorkboardSessionsBoard = {
    id: "sessions",
    name: "Team sessions",
    kind: "sessions",
    createdAt: 1,
    updatedAt: 1,
    sessions: {
      columns: [
        {
          id: "working",
          label: "Working",
          description: "Active work",
          match: { run: ["active"] },
        },
        { id: "done", label: "Done", description: "Completed work", fallback: true },
      ],
    },
  };
  const allSessions: WorkboardSessionsBoardRead["sessions"] = [
    {
      key: "agent:main:working",
      sessionId: "working-id",
      agentId: "main",
      label: "Fix retries",
      run: "active",
      pullRequests: [],
      archived: false,
      lastActivityAt: Date.now() - 60_000,
      columnId: "working",
      source: "state",
      reason: "Active run",
    },
    {
      key: "agent:writer:done",
      sessionId: "done-id",
      agentId: "writer",
      label: "Write guide",
      run: "idle",
      pullRequests: [],
      archived: false,
      lastActivityAt: Date.now() - 30_000,
      columnId: "done",
      source: "state",
      reason: "fallback",
    },
  ];
  const page = mountPage({ boardId: board.id });
  const fallback = expectDefined(page.request.getMockImplementation(), "request");
  page.request.mockImplementation(async (method, params) => {
    if (method === "gateway.identity.get") {
      return { deviceId: "gateway-one" };
    }
    if (method === "users.self") {
      return { profile: { id: "viewer" } };
    }
    if (method === "workboard.cards.list") {
      return { cards: [], boards: [{ ...board, total: 0, active: 0, archived: 0, byStatus: {} }] };
    }
    if (method === "workboard.sessionsBoard.read") {
      const view = (params as { view?: { agentId?: string } }).view;
      const filtered = view?.agentId
        ? allSessions.filter((session) => session.agentId === view.agentId)
        : allSessions;
      return {
        board,
        columns: board.sessions.columns,
        people: [],
        sessions: filtered.slice(0, 1),
        total: filtered.length,
        ...(filtered.length > 1 ? { nextCursor: filtered[0]!.key } : {}),
      };
    }
    return fallback(method, params);
  });

  page.fixture.connection.connected = true;
  page.fixture.notify();
  await vi.advanceTimersByTimeAsync(0);

  const pagination = expectDefined(
    page.container.querySelector(".workboard-board-viewport ~ .workboard-sessions__pagination"),
    "pagination footer below board viewport",
  );
  expect(pagination.textContent).toContain("Showing 1 of 2 sessions");
  expect(pagination.textContent).not.toContain("agent filter");

  const picker = expectDefined(
    page.container.querySelector<HTMLElement & ControlUiAgentPickerProps>(
      ".workboard-agent-filter [data-test-agent-picker]",
    ),
    "agent filter",
  );
  picker.onSelect("writer");
  await vi.advanceTimersByTimeAsync(0);
  expect(page.request).toHaveBeenLastCalledWith("workboard.sessionsBoard.read", {
    boardId: "sessions",
    view: { includePeople: true, agentId: "writer" },
  });
  expect(page.container.querySelector(".workboard-sessions__pagination")).toBeNull();
  expect(page.container.querySelectorAll(".workboard-session-tile")).toHaveLength(1);
  expect(page.container.textContent).toContain("Write guide");

  picker.onSelect("");
  await vi.advanceTimersByTimeAsync(0);
  expect(page.request).toHaveBeenLastCalledWith("workboard.sessionsBoard.read", {
    boardId: "sessions",
    view: { includePeople: true },
  });
  page.dispose();
});
