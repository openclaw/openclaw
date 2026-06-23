import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendConfig } from "../client/types.js";
import type { PendingTask } from "./types.js";

// Mock the HTTP client so the adapter can be driven with staged backend payloads.
const getJson = vi.fn();
vi.mock("../client/http-client.js", () => ({
  getJson: (...args: unknown[]) => getJson(...args),
}));

const { pollLinkCheck } = await import("./link-check-adapter.js");

const config = {} as BackendConfig;
const task: PendingTask = {
  id: "link_check:u1",
  kind: "link_check",
  uid: "1749",
  backendId: "u1",
  sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_1",
  mercureTopic: "lobster/user/1749",
  delivery: {},
  title: "广本3条",
  createdAt: 0,
  attempts: 0,
  notified: false,
  expiresAt: 0,
};

beforeEach(() => getJson.mockReset());

describe("pollLinkCheck", () => {
  it("is not terminal while the task is still running", async () => {
    getJson.mockResolvedValueOnce({ task: { status: "running" } });
    const res = await pollLinkCheck(task, "key", config);
    expect(res.terminal).toBe(false);
    expect(getJson).toHaveBeenCalledTimes(1); // no results fetch while running
  });

  it("summarizes verdicts and lists 失效 links when done", async () => {
    getJson
      .mockResolvedValueOnce({ task: { status: "done" } })
      .mockResolvedValueOnce({
        list: [
          { url: "https://a.com/1", verdict: "invalid" },
          { url: "https://a.com/2", verdict: "valid" },
          { url: "https://a.com/3", verdict: "blocked" },
        ],
      });
    const res = await pollLinkCheck(task, "key", config);
    expect(res.terminal).toBe(true);
    expect(res.summary).toContain("「广本3条」已完成，共 3 条");
    expect(res.summary).toContain("失效 1");
    expect(res.summary).toContain("正常 1");
    expect(res.summary).toContain("被拦截 1");
    expect(res.summary).toContain("https://a.com/1（失效）");
  });

  it("reports a terminal failure without fetching results", async () => {
    getJson.mockResolvedValueOnce({ task: { status: "failed" } });
    const res = await pollLinkCheck(task, "key", config);
    expect(res.terminal).toBe(true);
    expect(res.summary).toContain("失败");
    expect(getJson).toHaveBeenCalledTimes(1);
  });

  it("throws when the backend detail call returns an envelope error", async () => {
    getJson.mockResolvedValueOnce({ code: "danger", message: "boom" });
    await expect(pollLinkCheck(task, "key", config)).rejects.toThrow(/detail failed/);
  });
});
