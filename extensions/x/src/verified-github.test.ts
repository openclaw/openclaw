import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginServiceContextV2 } from "openclaw/plugin-sdk/plugin-entry";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveXAccount } from "./accounts.js";
import { openXAllowlist } from "./allowlist.js";
import { createXApiClient } from "./api.js";
import { xPlugin } from "./channel.js";
import { getXApi } from "./client.js";
import { createXGitHubReader } from "./github.js";
import { formatXSenderLine } from "./guest-policy.js";
import { resolveXIngress } from "./ingress.js";
import { XBudgetExceededError } from "./spend.js";
import { config, fixture, post } from "./test-support/monitor-fixture.js";
import { createXTestSpend } from "./test-support/spend.js";
import { createXGitHubService } from "./verified-github-service.js";
import { getXGitHubStatus, syncXGitHub } from "./verified-github.js";

const network = vi.hoisted(() => ({
  github: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("./github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github.js")>();
  return {
    ...actual,
    createXGitHubReader: (options: Parameters<typeof actual.createXGitHubReader>[0]) =>
      actual.createXGitHubReader({ ...options, fetch: options.fetch ?? network.github }),
  };
});
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  getXApi: vi.fn(),
  getXTokenState: () => "ready",
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
  network.github.mockReset();
  vi.mocked(getXApi).mockReset();
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
});

function githubFixture(dailyUsd = 1) {
  const cfg: OpenClawConfig = {
    ...config,
    channels: {
      x: {
        ...config.channels?.x,
        verifiedFromGitHub: { repo: "test/repo", token: "synthetic-token" },
      },
    },
  };
  const host = fixture({ posts: [], cfg });
  const source = {
    people: [{ login: "writer", handle: "alice" }],
    failing: false,
  };
  network.github.mockImplementation(async (input) => {
    if (source.failing) {
      return Response.json({ message: "private upstream details" }, { status: 503 });
    }
    const url = new URL(input);
    const path = url.pathname;
    if (path.endsWith("/collaborators")) {
      const page = Number(url.searchParams.get("page") ?? "1");
      return Response.json(
        source.people
          .map((person, index) => ({
            id: index + 1,
            login: person.login,
            permissions: { push: true, maintain: false, admin: false },
          }))
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
    return Response.json({
      id: index + 1,
      login: person.login,
      twitter_username: person.handle,
    });
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
  const github = createXGitHubReader({ token: "synthetic-token" });
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
  return { ...host, cfg, source, ids, lookups, spend, account, sync };
}

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
    const authorized = await openXAllowlist(test.runtime).readSnapshot(
      "default",
      test.account.config.verifiedFromGitHub,
    );
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
    expect(await getXGitHubStatus(test.runtime, test.account)).toEqual({
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
    const authorized = await resolveXIngress("default", post("501", "101"), test.cfg);
    expect(authorized.tier).toBe("maintainer");
    expect(authorized.ingress.senderAccess.allowed).toBe(true);
    expect(
      formatXSenderLine(
        authorized.tier,
        "101",
        { id: "101", username: "alice", name: "Alice" },
        authorized.github,
      ),
    ).toBe(
      "This is from a verified user: @alice (Alice), X user id 101, GitHub @writer with write access to test/repo.",
    );
    expect(
      xPlugin.groups!.resolveToolPolicy!({
        cfg: test.cfg,
        accountId: "default",
        senderId: "101",
        groupId: "500",
      }),
    ).toBeUndefined();
    const captured = await allowlist.readSnapshot(
      "default",
      test.account.config.verifiedFromGitHub,
    );
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    test.resolveStable.mockImplementationOnce(async (params) => {
      entered.resolve();
      await resume.promise;
      return resolveStableChannelMessageIngress(params);
    });
    const pending = resolveXIngress("default", post("502", "101"), test.cfg);
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
    const revoked = await resolveXIngress("default", post("503", "101"), test.cfg);
    expect(revoked.tier).toBe("guest");
    expect(revoked.ingress.senderAccess.allowed).toBe(false);
    expect(revoked.github).toBeUndefined();
    expect(
      xPlugin.groups!.resolveToolPolicy!({
        cfg: test.cfg,
        accountId: "default",
        senderId: "101",
        groupId: "500",
      }),
    ).toBeDefined();
    for (const id of ["10", "30"]) {
      const retained = await resolveXIngress("default", post("504", id), test.cfg);
      expect(retained.tier).toBe("maintainer");
      expect(retained.ingress.senderAccess.allowed).toBe(true);
    }
  });

  it("preserves the completed snapshot if the spend gate blocks a newly declared user", async () => {
    const test = githubFixture(0.01);
    await test.sync();
    const previous = await getXGitHubStatus(test.runtime, test.account);
    test.source.people.push({ login: "second", handle: "bob" });
    await expect(test.sync()).rejects.toBeInstanceOf(XBudgetExceededError);
    expect(test.lookups).toEqual([["alice"]]);
    expect(await getXGitHubStatus(test.runtime, test.account)).toEqual(previous);
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
    const partial = await getXGitHubStatus(test.runtime, test.account);
    expect(partial).toMatchObject({ entries: [], stale: true });
    expect(partial?.lastSyncAt).toBeUndefined();
    const pending = await resolveXIngress("default", post("501", "1000"), test.cfg);
    expect(pending.ingress.senderAccess.allowed).toBe(false);

    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    const completed = await test.sync();
    expect(test.lookups).toEqual([handles.slice(0, 100), ["writer100"]]);
    expect(completed.entries).toHaveLength(101);
    expect(completed.entries.map((entry) => entry.xUserId)).toEqual(
      Array.from({ length: 101 }, (_, index) => String(1_000 + index)),
    );
    expect(completed.stale).toBe(false);
    expect(await test.spend.status()).toMatchObject({ dayUsd: 0.01, cycleUsd: 1.01 });
    const admitted = await resolveXIngress("default", post("502", "1000"), test.cfg);
    expect(admitted.ingress.senderAccess.allowed).toBe(true);
  });
});

describe("X GitHub verification service", () => {
  it("schedules no work when the feature is absent", async () => {
    const host = fixture({ posts: [] });
    const clock = createGatewaySchedulerClock(Date.now());
    const gateway = createTestGatewayScheduler(clock.clock);
    const scheduler = createTestPluginServiceScheduler(gateway);
    const service = createXGitHubService({ runtime: host.runtime });
    const context: OpenClawPluginServiceContextV2 = {
      config,
      stateDir: host.runtime.state.resolveStateDir(),
      logger: host.logger,
      scheduler,
    };
    try {
      await service.start(context);
      await clock.advanceBy(2 * 60 * 60_000);
      expect(clock.armedAtMs).toBeNull();
      expect(network.github).not.toHaveBeenCalled();
      expect(
        await getXGitHubStatus(host.runtime, resolveXAccount(config, "default")),
      ).toBeUndefined();
    } finally {
      await scheduler.stop();
      await service.stop?.(context);
      await gateway.stop();
    }
  });

  it("keeps the last good set stale during failures, logs once per streak, and recovers on its next scheduled sync", async () => {
    const test = githubFixture();
    const clock = createGatewaySchedulerClock(Date.now());
    const gateway = createTestGatewayScheduler(clock.clock);
    const scheduler = createTestPluginServiceScheduler(gateway);
    const service = createXGitHubService({ runtime: test.runtime });
    const context: OpenClawPluginServiceContextV2 = {
      config: test.cfg,
      stateDir: test.runtime.state.resolveStateDir(),
      logger: test.logger,
      scheduler,
    };
    const nextSync = async () => {
      vi.setSystemTime(Date.now() + 60 * 60_000);
      await clock.advanceBy(60 * 60_000);
    };
    try {
      await service.start(context);
      await clock.wake();
      const good = await getXGitHubStatus(test.runtime, test.account);
      expect(good).toMatchObject({
        stale: false,
        entries: [{ xUserId: "101" }],
        lastSyncAt: Date.now(),
      });
      const authorized = await openXAllowlist(test.runtime).readSnapshot(
        "default",
        test.account.config.verifiedFromGitHub,
      );
      test.source.failing = true;
      await nextSync();
      await nextSync();
      expect(await getXGitHubStatus(test.runtime, test.account)).toMatchObject({
        stale: true,
        entries: good!.entries,
        lastSyncAt: good!.lastSyncAt,
      });
      expect(test.logger.warn).toHaveBeenCalledOnce();
      expect(authorized.assertCurrent).not.toThrow();
      expect(test.logger.warn.mock.calls[0]?.[0]).not.toContain("private upstream details");
      const retained = await resolveXIngress("default", post("501", "101"), test.cfg);
      expect(retained.tier).toBe("maintainer");
      expect(retained.ingress.senderAccess.allowed).toBe(true);
      test.source.failing = false;
      await nextSync();
      expect(await getXGitHubStatus(test.runtime, test.account)).toMatchObject({
        stale: false,
        lastSyncAt: Date.now(),
      });
      expect(test.lookups).toEqual([["alice"]]);
      test.source.failing = true;
      await nextSync();
      expect(test.logger.warn).toHaveBeenCalledTimes(2);
    } finally {
      await scheduler.stop();
      await service.stop?.(context);
      await gateway.stop();
    }
  });
});
