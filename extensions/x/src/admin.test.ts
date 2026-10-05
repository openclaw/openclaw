import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerXAllowlistMethods } from "./admin.js";

const getUserByUsername = vi.hoisted(() => vi.fn());
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  getXApi: async () => ({ getUserByUsername }),
}));

type Handler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
type Request = Parameters<Handler>[0];

function memoryStore<T>(beforeWrite?: () => Promise<void>): PluginStateKeyedStore<T> {
  const rows = new Map<string, T>();
  return {
    async register(key, value, options) {
      await beforeWrite?.();
      options?.assertCurrent?.();
      rows.set(key, structuredClone(value));
    },
    async registerIfAbsent(key, value) {
      if (rows.has(key)) {
        return false;
      }
      rows.set(key, structuredClone(value));
      return true;
    },
    async lookup(key) {
      return structuredClone(rows.get(key));
    },
    async consume(key) {
      const value = rows.get(key);
      rows.delete(key);
      return value;
    },
    async delete(key, options) {
      await beforeWrite?.();
      options?.assertCurrent?.();
      return rows.delete(key);
    },
    async entries() {
      return [...rows].map(([key, value]) => ({
        key,
        value: structuredClone(value),
        createdAt: 0,
      }));
    },
    async clear() {
      rows.clear();
    },
  };
}

function gateway(beforeWrite?: () => Promise<void>, configOverride?: OpenClawConfig) {
  const handlers = new Map<string, Handler>();
  const scopes = new Map<string, string | undefined>();
  const config = configOverride ?? {
    channels: {
      x: {
        userId: "100",
        username: "roboclawbot",
        allowFrom: ["x:10", "20"],
        accounts: { second: { userId: "101", username: "anotherbot", allowFrom: [] } },
      },
    },
  };
  registerXAllowlistMethods({
    runtime: {
      state: { openKeyedStore: () => memoryStore(beforeWrite) },
    },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    registerGatewayMethod(method, handler, options) {
      handlers.set(method, handler);
      scopes.set(method, options?.scope);
    },
  });
  async function invoke(
    method: string,
    params: Record<string, unknown> = {},
    overrides: Partial<Request> = {},
  ) {
    const respond = vi.fn();
    const handler = handlers.get(method);
    if (!handler) {
      throw new Error(`Missing handler: ${method}`);
    }
    // The captured handler reads only these authenticated request fields.
    await handler({
      params,
      respond,
      context: { getRuntimeConfig: () => config },
      client: {
        connect: { scopes: ["operator.admin"] },
        authenticatedUserId: "maintainer@example.test",
        connId: "connection-1",
      },
      hasCurrentClientAuthority: () => true,
      ...overrides,
    } as Request);
    return respond;
  }
  return { invoke, scopes };
}

beforeEach(() => {
  getUserByUsername.mockReset();
  getUserByUsername.mockResolvedValue({ id: "30", username: "maintainer", name: "Maintainer" });
});

describe("X allowlist Gateway methods", () => {
  it("selects a named account when no default account exists", async () => {
    const { invoke } = gateway(undefined, {
      channels: {
        x: {
          accounts: {
            maintainers: { userId: "101", username: "maintainers_bot", allowFrom: ["x:40"] },
          },
        },
      },
    });
    const listed = await invoke("x.allowlist.list");
    expect(listed).toHaveBeenCalledWith(true, {
      accountId: "maintainers",
      accounts: [{ accountId: "maintainers", username: "maintainers_bot" }],
      entries: [{ userId: "40", configured: true, editable: false }],
    });
  });

  it("resolves handles, records the caller, merges config IDs, and removes only stored grants", async () => {
    const { invoke } = gateway();
    const added = await invoke("x.allowlist.add", {
      username: "@maintainer",
      addedBy: "untrusted-request-identity",
    });
    expect(getUserByUsername).toHaveBeenCalledWith("maintainer", undefined);
    expect(added).toHaveBeenCalledWith(true, {
      accountId: "default",
      accounts: [
        { accountId: "default", username: "roboclawbot" },
        { accountId: "second", username: "anotherbot" },
      ],
      entries: [
        { userId: "10", configured: true, editable: false },
        { userId: "20", configured: true, editable: false },
        {
          userId: "30",
          username: "maintainer",
          name: "Maintainer",
          addedBy: "maintainer@example.test",
          addedAt: expect.any(Number),
          configured: false,
          editable: true,
        },
      ],
    });
    const sibling = await invoke("x.allowlist.list", { accountId: "second" });
    expect(sibling).toHaveBeenCalledWith(true, expect.objectContaining({ entries: [] }));
    const removed = await invoke("x.allowlist.remove", { userId: "x:30" });
    expect(removed).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        entries: [
          { userId: "10", configured: true, editable: false },
          { userId: "20", configured: true, editable: false },
        ],
      }),
    );

    getUserByUsername.mockResolvedValue({ id: "10", username: "configured", name: "Configured" });
    const duplicate = await invoke("x.allowlist.add", { username: "configured" });
    expect(duplicate).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        entries: expect.arrayContaining([
          expect.objectContaining({ userId: "10", configured: true, editable: true }),
        ]),
      }),
    );
    const stillConfigured = await invoke("x.allowlist.remove", { userId: "10" });
    expect(stillConfigured).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        entries: expect.arrayContaining([{ userId: "10", configured: true, editable: false }]),
      }),
    );
  });

  it.each(["list", "add", "remove"])("requires administrator authority for %s", async (method) => {
    const { invoke, scopes } = gateway();
    const response = await invoke(
      `x.allowlist.${method}`,
      { username: "maintainer", userId: "30" },
      {
        client: { connect: { scopes: ["operator.write"] } } as Request["client"],
      },
    );
    expect(scopes.get(`x.allowlist.${method}`)).toBe("operator.admin");
    expect(response).toHaveBeenCalledWith(false, undefined, {
      code: "FORBIDDEN",
      message: expect.stringContaining("administrator"),
    });
    expect(getUserByUsername).not.toHaveBeenCalled();
  });

  it("does not add a grant if caller authority expires during the X lookup", async () => {
    const { invoke } = gateway();
    let active = true;
    getUserByUsername.mockImplementation(async () => {
      active = false;
      return { id: "30", username: "maintainer" };
    });
    const response = await invoke(
      "x.allowlist.add",
      { username: "maintainer" },
      {
        hasCurrentClientAuthority: () => active,
      },
    );
    expect(response).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    const listed = await invoke("x.allowlist.list");
    expect(listed).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        entries: [
          { userId: "10", configured: true, editable: false },
          { userId: "20", configured: true, editable: false },
        ],
      }),
    );
  });

  it("rechecks operator authority when a queued state write is admitted", async () => {
    const ready = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const { invoke } = gateway(async () => {
      ready.resolve();
      await resume.promise;
    });
    let active = true;
    const response = invoke(
      "x.allowlist.add",
      { username: "maintainer" },
      { hasCurrentClientAuthority: () => active },
    );
    await ready.promise;
    active = false;
    resume.resolve();
    expect(await response).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    const listed = await invoke("x.allowlist.list");
    expect(listed).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        entries: [
          { userId: "10", configured: true, editable: false },
          { userId: "20", configured: true, editable: false },
        ],
      }),
    );
  });

  it("rejects invalid handles and unknown accounts without making paid lookups", async () => {
    const { invoke } = gateway();
    for (const params of [
      { username: "https://x.com/person" },
      { username: "person", accountId: "missing" },
    ]) {
      const response = await invoke("x.allowlist.add", params);
      expect(response).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    }
    expect(getUserByUsername).not.toHaveBeenCalled();
  });
});
