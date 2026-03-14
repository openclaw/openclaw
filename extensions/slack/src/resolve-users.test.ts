import { describe, expect, it, vi } from "vitest";
import { resolveSlackUserAllowlist } from "./resolve-users.js";

describe("resolveSlackUserAllowlist", () => {
  it("resolves by email and prefers active human users", async () => {
    const client = {
      users: {
        list: vi.fn().mockResolvedValue({
          members: [
            {
              id: "U1",
              name: "bot-user",
              is_bot: true,
              deleted: false,
              profile: { email: "person@example.com" },
            },
            {
              id: "U2",
              name: "person",
              is_bot: false,
              deleted: false,
              profile: { email: "person@example.com", display_name: "Person" },
            },
          ],
        }),
        info: vi.fn(),
      },
    };

    const res = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["person@example.com"],
      client: client as never,
    });

    expect(res[0]).toMatchObject({
      resolved: true,
      id: "U2",
      name: "Person",
      email: "person@example.com",
      isBot: false,
    });
    // Email-based entries should use users.list, not users.info
    expect(client.users.list).toHaveBeenCalled();
    expect(client.users.info).not.toHaveBeenCalled();
  });

  it("resolves ID-based entries via users.info instead of users.list", async () => {
    const client = {
      users: {
        list: vi.fn(),
        info: vi.fn().mockResolvedValue({
          user: {
            id: "U03A3QXEER3",
            name: "alice",
            is_bot: false,
            deleted: false,
            profile: { display_name: "Alice", email: "alice@example.com" },
          },
        }),
      },
    };

    const res = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["U03A3QXEER3"],
      client: client as never,
    });

    expect(res[0]).toMatchObject({
      resolved: true,
      id: "U03A3QXEER3",
      name: "Alice",
      email: "alice@example.com",
    });
    // ID-based entries should use users.info, NOT users.list
    expect(client.users.info).toHaveBeenCalledWith({ user: "U03A3QXEER3" });
    expect(client.users.list).not.toHaveBeenCalled();
  });

  it("keeps unresolved users", async () => {
    const client = {
      users: {
        list: vi.fn().mockResolvedValue({ members: [] }),
        info: vi.fn(),
      },
    };

    const res = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["@missing-user"],
      client: client as never,
    });

    expect(res[0]).toEqual({ input: "@missing-user", resolved: false });
  });

  it("preserves original entry order with mixed ID and name entries", async () => {
    const client = {
      users: {
        list: vi.fn().mockResolvedValue({
          members: [
            {
              id: "U2",
              name: "bob",
              is_bot: false,
              deleted: false,
              profile: { display_name: "Bob" },
            },
          ],
        }),
        info: vi.fn().mockResolvedValue({
          user: { id: "U1", name: "alice", profile: { display_name: "Alice" } },
        }),
      },
    };

    const res = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["U1", "@bob"],
      client: client as never,
    });

    expect(res[0]).toMatchObject({ resolved: true, id: "U1", name: "Alice" });
    expect(res[1]).toMatchObject({ resolved: true, id: "U2", name: "Bob" });
  });

  it("returns resolved: false for users_not_found and does not abort other lookups", async () => {
    const client = {
      users: {
        list: vi.fn(),
        info: vi
          .fn()
          .mockRejectedValueOnce({ data: { error: "users_not_found" } })
          .mockResolvedValueOnce({
            user: { id: "U2", name: "valid", profile: { display_name: "Valid" } },
          }),
      },
    };

    const res = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["UGONE", "U2"],
      client: client as never,
    });

    expect(res[0]).toMatchObject({
      input: "UGONE",
      resolved: false,
      note: "users.info lookup failed",
    });
    expect(res[1]).toMatchObject({ resolved: true, id: "U2", name: "Valid" });
  });

  it("propagates unexpected users.info errors", async () => {
    const client = {
      users: {
        list: vi.fn(),
        info: vi.fn().mockRejectedValue(new Error("network timeout")),
      },
    };

    await expect(
      resolveSlackUserAllowlist({
        token: "xoxb-test",
        entries: ["UFAIL"],
        client: client as never,
      }),
    ).rejects.toThrow("network timeout");
  });
});
