import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerXAllowlistMethods } from "./admin.js";
import { openXSpend, XBudgetExceededError } from "./spend.js";
import { createKeyedState } from "./test-support/monitor.js";

const getUserByUsername = vi.hoisted(() => vi.fn());
const mutateConfigFile = vi.hoisted(() => vi.fn());
// mock-isolation: The Gateway handler owns the mutation; keep host config files outside this fixture.
vi.mock("openclaw/plugin-sdk/config-mutation", () => ({ mutateConfigFile }));
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  getXApi: async () => ({ getUserByUsername }),
}));

type Handler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
type Request = Parameters<Handler>[0];
let gatewaySequence = 0;

function gateway(beforeWrite?: () => Promise<void>, configOverride?: OpenClawConfig) {
  const handlers = new Map<string, Handler>();
  const scopes = new Map<string, string | undefined>();
  let config: OpenClawConfig = configOverride ?? {
    channels: {
      x: {
        userId: "100",
        username: "roboclawbot",
        allowFrom: ["x:10", "20"],
        accounts: { second: { userId: "101", username: "anotherbot", allowFrom: [] } },
      },
    },
  };
  mutateConfigFile.mockImplementation(
    async (params: {
      mutate: (draft: OpenClawConfig) => void;
      writeOptions?: { assertCurrent?: () => void };
    }) => {
      const draft = structuredClone(config);
      params.mutate(draft);
      await beforeWrite?.();
      params.writeOptions?.assertCurrent?.();
      config = draft;
      return { nextConfig: config };
    },
  );
  const stateDir = `synthetic-x-admin-${gatewaySequence++}`;
  const runtime = {
    state: {
      openKeyedStore: createKeyedState(undefined, beforeWrite),
      resolveStateDir: () => stateDir,
    },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  registerXAllowlistMethods({
    runtime,
    logger,
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
  return { invoke, scopes, runtime, logger, getConfig: () => config };
}

beforeEach(() => {
  getUserByUsername.mockReset();
  mutateConfigFile.mockReset();
  getUserByUsername.mockResolvedValue({ id: "30", username: "maintainer", name: "Maintainer" });
});

describe("X allowlist Gateway methods", () => {
  it("includes the selected account's recorded spend and limits without an X API lookup", async () => {
    const { invoke, runtime } = gateway(undefined, {
      channels: {
        x: {
          accounts: {
            small: {
              userId: "101",
              username: "small_bot",
              costLimits: { dailyUsd: 5, monthlyUsd: 25, cycleStartDay: 20 },
            },
            other: { userId: "102", username: "other_bot" },
          },
        },
      },
    });
    await openXSpend(runtime, "small", () => ({
      dailyUsd: 5,
      monthlyUsd: 25,
      cycleStartDay: 20,
    })).charge(250_000);
    expect(await invoke("x.allowlist.list", { accountId: "small" })).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        accountId: "small",
        spend: {
          dayUsd: 0.25,
          cycleUsd: 0.25,
          dailyLimitUsd: 5,
          monthlyLimitUsd: 25,
          cycleStart: expect.stringMatching(/^\d{4}-\d{2}-20$/),
        },
      }),
    );
    expect(await invoke("x.allowlist.list", { accountId: "other" })).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ spend: expect.objectContaining({ dayUsd: 0, cycleUsd: 0 }) }),
    );
    expect(getUserByUsername).not.toHaveBeenCalled();
  });

  it("reports budget refusals without duplicating the ledger's warning", async () => {
    const { invoke, logger } = gateway();
    const refusal = new XBudgetExceededError("X API daily budget reached; resumes tomorrow", 1);
    getUserByUsername.mockRejectedValue(refusal);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await invoke("x.allowlist.add", { username: "maintainer" })).toHaveBeenCalledWith(
        false,
        undefined,
        { code: "UNAVAILABLE", message: refusal.message },
      );
    }
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each(["implicit default", "explicit default", "named account"])(
    "persists guest mode for the %s while preserving other account settings",
    async (selection) => {
      const accountId = selection === "named account" ? "second" : "default";
      const { invoke, getConfig } = gateway(undefined, {
        channels: {
          x: {
            userId: "100",
            username: "example_bot",
            guests: { enabled: false, maxMentionsPerAuthorPerDay: 7 },
            costLimits: { dailyUsd: 100, monthlyUsd: 1000, cycleStartDay: 20 },
            accounts: {
              ...(selection === "explicit default" ? { default: {} } : {}),
              second: {
                userId: "101",
                username: "second_bot",
                guests: { threadContextMaxPosts: 4 },
                costLimits: { dailyUsd: 5 },
              },
            },
          },
        },
      });
      const enabled = await invoke("x.guests.set", { accountId, enabled: true });
      expect(enabled).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          accountId,
          spend: expect.objectContaining({
            dailyLimitUsd: selection === "named account" ? 5 : 100,
            monthlyLimitUsd: 1000,
            cycleStart: expect.stringMatching(/^\d{4}-\d{2}-20$/),
          }),
          guests: expect.objectContaining({
            enabled: true,
            maxMentionsPerAuthorPerDay: 7,
            admittedToday: 0,
            rateLimitedToday: 0,
          }),
        }),
      );
      const channel = getConfig().channels!.x;
      const selected = selection === "implicit default" ? channel : channel.accounts[accountId];
      expect(selected.guests.enabled).toBe(true);
      expect(channel.guests.maxMentionsPerAuthorPerDay).toBe(7);
      expect(channel.accounts.second.guests.threadContextMaxPosts).toBe(4);
      expect(channel.costLimits).toEqual({ dailyUsd: 100, monthlyUsd: 1000, cycleStartDay: 20 });
      expect(channel.accounts.second.costLimits).toEqual({ dailyUsd: 5 });
      expect(channel.guests.enabled).toBe(selection === "implicit default");
      expect(mutateConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          afterWrite: { mode: "auto" },
        }),
      );
      const disabled = await invoke("x.guests.set", { accountId, enabled: false });
      expect(disabled).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          guests: expect.objectContaining({ enabled: false }),
        }),
      );
      const listed = await invoke("x.allowlist.list", { accountId });
      expect(listed).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          guests: expect.objectContaining({ enabled: false }),
        }),
      );
    },
  );

  it.each(["default route", "thread binding"] as const)(
    "reports containment setup failures for the %s in toggle and list snapshots",
    async (route) => {
      const blockedAgent = route === "default route" ? "front" : "thread";
      const { invoke, getConfig } = gateway(undefined, {
        agents: {
          entries: {
            front: { skills: [], tools: { fs: { workspaceOnly: route !== "default route" } } },
            thread: { skills: [], tools: { fs: { workspaceOnly: false } } },
          },
        },
        bindings: [
          { agentId: "front", match: { channel: "x" } },
          ...(route === "thread binding"
            ? [
                {
                  agentId: "thread",
                  match: { channel: "x", peer: { kind: "group" as const, id: "500" } },
                },
              ]
            : []),
        ],
        channels: { x: { userId: "100", username: "example_bot" } },
      });
      const enabled = await invoke("x.guests.set", { enabled: true });
      expect(enabled).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          guests: expect.objectContaining({
            enabled: true,
            blockedReason: expect.stringContaining(
              `agents.entries.${blockedAgent}.tools.fs.workspaceOnly=true`,
            ),
          }),
        }),
      );
      const listed = await invoke("x.allowlist.list");
      expect(listed).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          guests: expect.objectContaining({
            blockedReason: expect.stringContaining(
              `agents.entries.${blockedAgent}.tools.fs.workspaceOnly=true`,
            ),
          }),
        }),
      );
      getConfig().agents!.entries![blockedAgent]!.tools = { fs: { workspaceOnly: true } };
      const repaired = await invoke("x.allowlist.list");
      expect(repaired.mock.calls[0]?.[1].guests.blockedReason).toBeUndefined();
    },
  );

  it("keeps guest toggles readable when X has only thread bindings in a multi-agent setup", async () => {
    const { invoke } = gateway(undefined, {
      agents: {
        ownership: "explicit",
        entries: {
          front: { skills: [], tools: { fs: { workspaceOnly: true } } },
          other: {},
        },
      },
      bindings: [{ agentId: "front", match: { channel: "x", peer: { kind: "group", id: "500" } } }],
      channels: { x: { userId: "100", username: "example_bot" } },
    });
    for (const response of [
      await invoke("x.guests.set", { enabled: true }),
      await invoke("x.allowlist.list"),
    ]) {
      expect(response).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          guests: expect.objectContaining({
            enabled: true,
            blockedReason: expect.stringContaining("X agent bindings"),
          }),
        }),
      );
    }
    const disabled = await invoke("x.guests.set", { enabled: false });
    expect(disabled).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        guests: expect.objectContaining({ enabled: false }),
      }),
    );
  });

  it("rejects invalid guest toggles before attempting a config write", async () => {
    const { invoke } = gateway();
    for (const params of [{ enabled: "true" }, { enabled: true, accountId: "missing" }]) {
      const response = await invoke("x.guests.set", params);
      expect(response).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
        }),
      );
    }
    expect(mutateConfigFile).not.toHaveBeenCalled();
  });

  it("rechecks administrator authority before committing a queued guest toggle", async () => {
    const ready = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const { invoke, getConfig } = gateway(async () => {
      ready.resolve();
      await resume.promise;
    });
    let active = true;
    const response = invoke(
      "x.guests.set",
      { enabled: true },
      {
        hasCurrentClientAuthority: () => active,
      },
    );
    await ready.promise;
    active = false;
    resume.resolve();
    expect(await response).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "FORBIDDEN",
      }),
    );
    expect(getConfig().channels?.x.guests).toBeUndefined();
  });

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
      guests: expect.objectContaining({ enabled: false }),
      spend: {
        dayUsd: 0,
        cycleUsd: 0,
        dailyLimitUsd: 100,
        monthlyLimitUsd: 1000,
        cycleStart: expect.any(String),
      },
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
      guests: expect.objectContaining({ enabled: false }),
      spend: {
        dayUsd: 0,
        cycleUsd: 0,
        dailyLimitUsd: 100,
        monthlyLimitUsd: 1000,
        cycleStart: expect.any(String),
      },
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

  it.each(["x.allowlist.list", "x.allowlist.add", "x.allowlist.remove", "x.guests.set"])(
    "requires administrator authority for %s",
    async (method) => {
      const { invoke, scopes } = gateway();
      const response = await invoke(
        method,
        { username: "maintainer", userId: "30", enabled: true },
        {
          client: { connect: { scopes: ["operator.write"] } } as Request["client"],
        },
      );
      expect(scopes.get(method)).toBe("operator.admin");
      expect(response).toHaveBeenCalledWith(false, undefined, {
        code: "FORBIDDEN",
        message: expect.stringContaining("administrator"),
      });
      expect(getUserByUsername).not.toHaveBeenCalled();
      expect(mutateConfigFile).not.toHaveBeenCalled();
    },
  );

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
