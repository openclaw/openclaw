import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveXAccount } from "./accounts.js";
import { openXAllowlist } from "./allowlist.js";
import { xPlugin } from "./channel.js";
import { getXApi } from "./client.js";
import { createXGitHubReader } from "./github.js";
import { formatXSenderLine } from "./guest-policy.js";
import { resolveXIngress } from "./ingress.js";
import { XBudgetExceededError } from "./spend.js";
import { createXTestApi as createXApiClient } from "./test-support/api-client.js";
import { setXTestFetch } from "./test-support/fetch.js";
import { config, fixture, post } from "./test-support/monitor-fixture.js";
import { createXTestSpend } from "./test-support/spend.js";
import { createXGitHubService } from "./verified-github-service.js";
import { getXGitHubStatus, syncXGitHub } from "./verified-github.js";

const network = vi.hoisted(() => ({
  github: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  getXApi: vi.fn(),
  getXTokenState: () => "ready",
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
  network.github.mockReset();
  setXTestFetch("api.github.com", network.github);
  vi.mocked(getXApi).mockReset();
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
});

async function withService(
  { runtime, logger }: ReturnType<typeof fixture>,
  cfg: OpenClawConfig,
  run: (clock: ReturnType<typeof createGatewaySchedulerClock>) => Promise<void>,
) {
  const clock = createGatewaySchedulerClock(Date.now());
  const gateway = createTestGatewayScheduler(clock.clock);
  const scheduler = createTestPluginServiceScheduler(gateway);
  const service = createXGitHubService({ runtime });
  const stateDir = runtime.state.resolveStateDir();
  const context = { config: cfg, stateDir, logger, scheduler };
  try {
    await service.start(context);
    await run(clock);
  } finally {
    await scheduler.stop();
    await service.stop?.(context);
    await gateway.stop();
  }
}

function githubFixture(dailyUsd = 1) {
  const verifiedFromGitHub = { repo: "test/repo", token: "synthetic-token" };
  const x = { ...config.channels?.x, verifiedFromGitHub };
  const cfg: OpenClawConfig = { ...config, channels: { x } };
  const host = fixture({ posts: [], cfg });
  const source = { people: [{ login: "writer", handle: "alice" }], failing: false };
  const permissions = { push: true, maintain: false, admin: false };
  network.github.mockImplementation(async (input) => {
    if (source.failing) {
      return Response.json({ message: "private upstream details" }, { status: 503 });
    }
    const { pathname: path, searchParams } = new URL(input);
    if (path.endsWith("/collaborators")) {
      const page = Number(searchParams.get("page") ?? "1");
      return Response.json(
        source.people
          .map(({ login }, index) => ({ id: index + 1, login, permissions }))
          .slice((page - 1) * 100, page * 100),
      );
    }
    if (path.endsWith("/social_accounts")) {
      return Response.json([]);
    }
    const index = source.people.findIndex((person) => path === `/users/${person.login}`);
    const person = source.people[index];
    if (!person) {
      throw new Error("Unexpected GitHub fixture path");
    }
    return Response.json({ id: index + 1, login: person.login, twitter_username: person.handle });
  });
  const lookups: string[][] = [];
  const ids: Record<string, string> = { alice: "101", bob: "102", alice_new: "103" };
  const spend = createXTestSpend({ dailyUsd });
  const api = createXApiClient({
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret",
    refreshToken: "synthetic-refresh",
    spend,
    saveRefreshToken: async () => {},
    fetch: async (input) => {
      const url = new URL(input);
      if (url.pathname === "/2/oauth2/token") {
        return Response.json({ access_token: "synthetic-access" });
      }
      expect(url.pathname).toBe("/2/users/by");
      const handles = url.searchParams.get("usernames")!.split(",");
      lookups.push(handles);
      return Response.json({
        data: handles.flatMap((username) =>
          ids[username] ? [{ id: ids[username], username }] : [],
        ),
      });
    },
  });
  vi.mocked(getXApi).mockResolvedValue(api);
  const account = resolveXAccount(cfg, "default");
  const github = createXGitHubReader({ token: verifiedFromGitHub.token });
  const abort = new AbortController();
  const sync = () =>
    syncXGitHub({
      runtime: host.runtime,
      account,
      github,
      getApi: async () => api,
      signal: abort.signal,
      assertCurrent: () => abort.signal.throwIfAborted(),
    });
  const status = () => getXGitHubStatus(host.runtime, account);
  const snapshot = () =>
    openXAllowlist(host.runtime).readSnapshot("default", account.config.verifiedFromGitHub);
  const ingress = (id: string, author = "101") => resolveXIngress("default", post(id, author), cfg);
  return { ...host, cfg, source, ids, lookups, spend, account, sync, status, snapshot, ingress };
}

const maintainerAccess = { tier: "maintainer", ingress: { senderAccess: { allowed: true } } };

describe("X GitHub verification sync", () => {
  it("persists resolved IDs, charges only returned users, and looks up only new or changed declarations", async () => {
    const test = githubFixture();
    test.source.people.push({ login: "unresolved", handle: "missing" });
    const first = await test.sync();
    expect(first.entries).toEqual([
      {
        xUserId: "101",
        xHandle: "alice",
        githubLogin: "writer",
        permission: "push",
        syncedAt: Date.now(),
      },
    ]);
    expect(first.unresolvedHandles).toEqual(["missing"]);
    const authorized = await test.snapshot();
    vi.setSystemTime(Date.now() + 60_000);
    await test.sync();
    expect(authorized.assertCurrent).not.toThrow();
    expect(test.lookups).toEqual([["alice", "missing"]]);
    test.source.people.push({ login: "second", handle: "bob" });
    await test.sync();
    test.source.people[0]!.handle = "alice_new";
    const changed = await test.sync();
    expect(test.lookups).toEqual([["alice", "missing"], ["bob"], ["alice_new"]]);
    expect(changed.entries.map((entry) => entry.xUserId)).toEqual(["103", "102"]);
    expect(await test.spend.status()).toMatchObject({ dayUsd: 0.03, cycleUsd: 0.03 });
    expect(await test.status()).toEqual({
      repo: "test/repo",
      entries: changed.entries,
      unresolvedHandles: ["missing"],
      lastSyncAt: Date.now(),
      stale: false,
    });
    const stored = test.openKeyedStore({ namespace: "x.verified-github" });
    expect(await stored.lookup("default")).toEqual(changed);
  });

  it("admits derived users through ingress and fences in-flight authorization when their collaborator disappears", async () => {
    const test = githubFixture();
    const allowlist = openXAllowlist(test.runtime);
    await allowlist.put("default", {
      userId: "30",
      username: "stored",
      name: "Stored",
      addedBy: "operator",
      addedAt: 0,
    });
    await test.sync();
    const authorized = await test.ingress("501");
    expect(authorized).toMatchObject(maintainerAccess);
    const alice = { id: "101", username: "alice", name: "Alice" };
    expect(formatXSenderLine(authorized.tier, alice.id, alice, authorized.github)).toBe(
      "This is from a verified user: @alice (Alice), X user id 101, GitHub @writer with write access to test/repo.",
    );
    const policy = () =>
      xPlugin.groups!.resolveToolPolicy!({
        cfg: test.cfg,
        accountId: "default",
        senderId: "101",
        groupId: "500",
      });
    expect(policy()).toBeUndefined();
    const captured = await test.snapshot();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    test.resolveStable.mockImplementationOnce(async (params) => {
      entered.resolve();
      await resume.promise;
      return resolveStableChannelMessageIngress(params);
    });
    const pending = test.ingress("502");
    const rejected = expect(pending).rejects.toThrow("allowlist changed");
    await entered.promise;
    test.source.people = [];
    try {
      await test.sync();
      expect(captured.assertCurrent).toThrow("allowlist changed");
      expect(authorized.assertCurrent).toThrow("allowlist changed");
    } finally {
      resume.resolve();
    }
    await rejected;
    const revoked = await test.ingress("503");
    expect(revoked.tier).toBe("guest");
    expect(revoked.ingress.senderAccess.allowed).toBe(false);
    expect(revoked.github).toBeUndefined();
    expect(policy()).toBeDefined();
    for (const id of ["10", "30"]) {
      const retained = await test.ingress("504", id);
      expect(retained).toMatchObject(maintainerAccess);
    }
  });

  it("resumes a paid batch from persisted lookups after the daily budget resets", async () => {
    const test = githubFixture(1);
    const handles = Array.from({ length: 101 }, (_, index) => `writer${index}`);
    test.source.people = handles.map((handle, index) => {
      test.ids[handle] = String(1_000 + index);
      return { login: handle, handle };
    });
    await expect(test.sync()).rejects.toBeInstanceOf(XBudgetExceededError);
    expect(test.lookups).toEqual([handles.slice(0, 100)]);
    expect(await test.spend.status()).toMatchObject({ dayUsd: 1, cycleUsd: 1 });
    const partial = await test.status();
    expect(partial).toMatchObject({ entries: [], stale: true });
    expect(partial?.lastSyncAt).toBeUndefined();
    const pending = await test.ingress("501", "1000");
    expect(pending.ingress.senderAccess.allowed).toBe(false);

    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    const completed = await test.sync();
    expect(test.lookups).toEqual([handles.slice(0, 100), ["writer100"]]);
    expect(completed.entries.map((entry) => entry.xUserId)).toEqual(
      Array.from({ length: 101 }, (_, index) => String(1_000 + index)),
    );
    expect(completed.stale).toBe(false);
    expect(await test.spend.status()).toMatchObject({ dayUsd: 0.01, cycleUsd: 1.01 });
    const admitted = await test.ingress("502", "1000");
    expect(admitted.ingress.senderAccess.allowed).toBe(true);
  });
});

describe("X GitHub verification service", () => {
  it("names reauthorization when the X refresh token is rejected", async () => {
    const test = githubFixture();
    setXTestFetch("api.x.com", async () =>
      Response.json(
        { error: "invalid_grant", error_description: "private provider details" },
        { status: 400 },
      ),
    );
    await withService(test, test.cfg, async (clock) => {
      await clock.wake();
      expect(await test.status()).toMatchObject({
        stale: true,
        message: expect.stringContaining("reauthorize the X account"),
      });
      expect(test.logger.warn.mock.calls[0]?.[0]).not.toContain("private provider details");
    });
  });

  it("schedules no work when the feature is absent", async () => {
    const host = fixture({ posts: [] });
    await withService(host, config, async (clock) => {
      await clock.advanceBy(2 * 60 * 60_000);
      expect(clock.armedAtMs).toBeNull();
      expect(network.github).not.toHaveBeenCalled();
      expect(
        await getXGitHubStatus(host.runtime, resolveXAccount(config, "default")),
      ).toBeUndefined();
    });
  });

  it("keeps the last good set stale during failures, logs once per streak, and recovers on its next scheduled sync", async () => {
    const test = githubFixture();
    await withService(test, test.cfg, async (clock) => {
      const nextSync = async () => {
        vi.setSystemTime(Date.now() + 60 * 60_000);
        await clock.advanceBy(60 * 60_000);
      };
      await clock.wake();
      const good = await test.status();
      expect(good).toMatchObject({
        stale: false,
        entries: [{ xUserId: "101" }],
        lastSyncAt: Date.now(),
      });
      const authorized = await test.snapshot();
      test.source.failing = true;
      await nextSync();
      await nextSync();
      expect(await test.status()).toMatchObject({
        stale: true,
        entries: good!.entries,
        lastSyncAt: good!.lastSyncAt,
      });
      expect(test.logger.warn).toHaveBeenCalledOnce();
      expect(authorized.assertCurrent).not.toThrow();
      expect(test.logger.warn.mock.calls[0]?.[0]).not.toContain("private upstream details");
      const retained = await test.ingress("501");
      expect(retained).toMatchObject(maintainerAccess);
      test.source.failing = false;
      await nextSync();
      expect(await test.status()).toMatchObject({ stale: false, lastSyncAt: Date.now() });
      expect(test.lookups).toEqual([["alice"]]);
      test.source.failing = true;
      await nextSync();
      expect(test.logger.warn).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps sync status and the X client for mixed-case account keys under the runtime account id", async () => {
    const test = githubFixture();
    const { verifiedFromGitHub, ...credentials } = test.cfg.channels!.x!;
    const cfg: OpenClawConfig = {
      ...test.cfg,
      channels: {
        x: {
          accounts: {
            Work: { ...credentials, verifiedFromGitHub },
            Ops: { ...credentials, userId: "200", verifiedFromGitHub: { repo: "test/repo" } },
          },
        },
      },
    };
    await withService(test, cfg, async (clock) => {
      await clock.wake();
      const status = (key: string) => getXGitHubStatus(test.runtime, resolveXAccount(cfg, key));
      expect({
        lookupAccounts: vi.mocked(getXApi).mock.calls.map(([accountId]) => accountId),
        work: await status("Work"),
        ops: await status("Ops"),
      }).toMatchObject({
        lookupAccounts: ["work"],
        work: { stale: false, entries: [{ xUserId: "101" }] },
        ops: {
          stale: true,
          message:
            "Configure verifiedFromGitHub.token with a GitHub credential that can list repository collaborators.",
        },
      });
    });
  });
});
