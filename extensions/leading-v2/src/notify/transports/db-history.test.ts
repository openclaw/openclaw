import { afterEach, describe, expect, it, vi } from "vitest";

const { mockExecute } = vi.hoisted(() => ({
  mockExecute: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("../../client/db-client.js", () => ({ execute: mockExecute }));

import type { MySqlConfig } from "../../client/types.js";
import type { Notification } from "../notification.js";
import { DbHistoryTransport, sessionIdFromKey } from "./db-history.js";

const db = { host: "h", port: 3306, user: "u", password: "p", database: "superworker" } as MySqlConfig;
const note: Notification = {
  id: "crawl_refresh:U1",
  uid: "1749",
  category: "crawl_refresh",
  level: "success",
  title: "互动量刷新完成",
  body: "转10 评5 赞100",
  ts: 1_750_000_000_000,
};

afterEach(() => vi.clearAllMocks());

describe("sessionIdFromKey", () => {
  it("extracts the session_ tail", () => {
    expect(sessionIdFromKey("agent:rabbitmq-1749:rabbitmq:1749:session_123_abc")).toBe("session_123_abc");
    expect(sessionIdFromKey("agent:rabbitmq-1749:rabbitmq:1749:nope")).toBeUndefined();
    expect(sessionIdFromKey(undefined)).toBeUndefined();
  });
});

describe("DbHistoryTransport", () => {
  it("inserts an assistant-only history row for the session", async () => {
    mockExecute.mockResolvedValue({ insertId: 9 });
    const t = new DbHistoryTransport(db);
    const res = await t.deliver(note, { sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_9_z" });

    expect(res.ok).toBe(true);
    const [, sql, params] = mockExecute.mock.calls[0] as [unknown, string, unknown[]];
    expect(sql).toContain("INSERT INTO history_messages");
    expect(sql).toContain("VALUES (?, ?, '', ?, NULL, NULL, NOW())");
    expect(params[0]).toBe("session_9_z"); // session_id
    expect(params[1]).toBe("1749"); // user_id
    expect(String(params[2])).toContain("互动量刷新完成");
    expect(String(params[2])).toContain("转10 评5 赞100");
  });

  it("skips when no session id is resolvable", async () => {
    const res = await new DbHistoryTransport(db).deliver(note, {});
    expect(res.ok).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
