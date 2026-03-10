import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchZulipStreams, fetchZulipUsers } from "./client.js";
import { parseZulipTarget, resolveZulipTargetForSend } from "./send.js";

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    fetchZulipStreams: vi.fn(),
    fetchZulipUsers: vi.fn(),
  };
});

const mockedFetchZulipStreams = vi.mocked(fetchZulipStreams);
const mockedFetchZulipUsers = vi.mocked(fetchZulipUsers);

const DUMMY_CLIENT = {
  baseUrl: "https://zulip.example.com",
  botEmail: "bot@example.com",
  botApiKey: "key",
  authHeader: "Basic abc",
  request: vi.fn(),
  requestForm: vi.fn(),
};

describe("parseZulipTarget", () => {
  it("parses numeric DMs directly", () => {
    expect(parseZulipTarget("dm:123,456")).toEqual({ kind: "dm", userIds: [123, 456] });
  });

  it("leaves email DMs pending for async resolution", () => {
    expect(parseZulipTarget("dm:alice@example.com")).toEqual({
      kind: "dm-pending",
      identities: ["alice@example.com"],
    });
  });
});

describe("resolveZulipTargetForSend", () => {
  beforeEach(() => {
    mockedFetchZulipStreams.mockReset();
    mockedFetchZulipUsers.mockReset();
    mockedFetchZulipStreams.mockResolvedValue([{ stream_id: 1, name: "Ops" }]);
    mockedFetchZulipUsers.mockResolvedValue([
      { user_id: 42, email: "alice@example.com", full_name: "Alice Jones", is_bot: false },
    ]);
  });

  it("normalizes stream names from live Zulip streams", async () => {
    await expect(
      resolveZulipTargetForSend({
        to: "stream:ops:topic:deploy",
        client: DUMMY_CLIENT,
      }),
    ).resolves.toEqual({ kind: "stream", stream: "Ops", topic: "deploy" });
  });

  it("resolves email DM targets to numeric user ids", async () => {
    await expect(
      resolveZulipTargetForSend({
        to: "dm:alice@example.com",
        client: DUMMY_CLIENT,
      }),
    ).resolves.toEqual({ kind: "dm", userIds: [42] });
  });

  it("rejects unresolvable email DM targets", async () => {
    mockedFetchZulipUsers.mockResolvedValue([]);
    await expect(
      resolveZulipTargetForSend({
        to: "dm:missing@example.com",
        client: DUMMY_CLIENT,
      }),
    ).rejects.toThrow(/Unable to resolve Zulip DM target/);
  });
});
