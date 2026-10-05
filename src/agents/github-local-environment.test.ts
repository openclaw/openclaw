import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { createWorkerGitHubBindingGrant } from "../gateway/worker-environments/worker-github-grant.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { AdmittedRunContext } from "./admitted-run-context.js";
import { prepareLocalGitHubEnvironment } from "./github-local-environment.js";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), operator: vi.fn() }));
vi.mock("../gateway/worker-environments/worker-github-binding.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../gateway/worker-environments/worker-github-binding.js")
    >();
  return {
    ...actual,
    prepareWorkerGitHubBindingGrant: mocks.prepare,
  };
});
vi.mock("./admitted-run-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./admitted-run-context.js")>();
  return {
    ...actual,
    readAdmittedRunOperatorAuthority: mocks.operator,
  };
});
const disposers: (() => Promise<void>)[] = [];
const request = {
  admittedRunContext: {} as AdmittedRunContext,
  sessionId: "local-run",
  sessionKey: "agent:main:local-run",
  assertCurrent: () => {},
  signal: new AbortController().signal,
};
const prepare = async () => {
  const result = await prepareLocalGitHubEnvironment(request);
  if (result) {
    disposers.push(result.dispose);
  }
  return result;
};
const selectedToken = "synthetic-selected-system-token";
const binding = {
  host: "fixture.ghe.com",
  token: selectedToken,
  login: "configured-system",
  gitAuthor: { name: "Verified Author", email: "author@example.test" },
};
function grant(refreshCredential = async () => ({ token: selectedToken })) {
  const controller = new AbortController();
  return createWorkerGitHubBindingGrant({
    binding,
    credential: { token: selectedToken },
    controller,
    signal: controller.signal,
    assertCurrent: () => {},
    refreshCredential,
    subscribe: () => [],
  });
}
beforeEach(() => {
  vi.stubEnv("OPENCLAW_GITHUB_APP_ID", "101");
  setRuntimeConfigSnapshot({
    gateway: { github: { host: "fixture.ghe.com", apiBaseUrl: "https://api.fixture.ghe.com" } },
  });
  mocks.prepare.mockReset().mockImplementation(async () => grant());
  mocks.operator.mockReturnValue(undefined);
});
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  vi.unstubAllEnvs();
  vi.useRealTimers();
  clearRuntimeConfigSnapshot();
});
describe("local native selected GitHub environment", () => {
  it("uses the selected account despite App configuration and preserves its author in private shell policy", async () => {
    const prepared = (await prepare())!;
    const hosts = parse(
      await fs.readFile(path.join(prepared.env.GH_CONFIG_DIR, "hosts.yml"), "utf8"),
    );
    expect(hosts["fixture.ghe.com"]).toMatchObject({
      user: "configured-system",
      oauth_token: selectedToken,
    });
    expect(prepared.env).toMatchObject({
      GH_HOST: "fixture.ghe.com",
      GH_TOKEN: "",
      GH_ENTERPRISE_TOKEN: "",
      GIT_AUTHOR_EMAIL: "author@example.test",
      GIT_COMMITTER_EMAIL: "author@example.test",
      OPENCLAW_GITHUB_APP_PRIVATE_KEY: "",
      OPENCLAW_GATEWAY_PASSWORD: "",
    });
    expect(JSON.stringify(prepared.env)).not.toContain(selectedToken);
    expect(prepared.instructions).toContain("configured-system");
    expect((await fs.stat(prepared.env.GH_CONFIG_DIR)).mode & 0o077).toBe(0);
  });
  it("projects the admitted App signal and private bot profile for native Codex without signing material", async () => {
    const selected = grant();
    const appGrant = {
      ...selected,
      binding: {
        ...selected.binding,
        login: "factory[bot]",
        executionKind: "app-installation" as const,
      },
    };
    mocks.prepare.mockResolvedValue(appGrant);
    const prepared = (await prepare())!;
    expect(prepared.env.OPENCLAW_GITHUB_EXECUTION_KIND).toBe("app-installation");
    const hosts = parse(
      await fs.readFile(path.join(prepared.env.GH_CONFIG_DIR, "hosts.yml"), "utf8"),
    );
    expect(hosts["fixture.ghe.com"].user).toBe("factory[bot]");
    expect(prepared.env.OPENCLAW_GITHUB_APP_PRIVATE_KEY).toBe("");
    expect(JSON.stringify(prepared.env)).not.toContain(selectedToken);
  });
  it("removes only the owning execution profile and leaves another execution current", async () => {
    const first = (await prepare())!;
    const second = (await prepare())!;
    expect(first.env.GH_CONFIG_DIR).not.toBe(second.env.GH_CONFIG_DIR);
    await first.dispose();
    expect(() => first.assertCurrent()).toThrow();
    await expect(fs.access(first.env.GH_CONFIG_DIR)).rejects.toMatchObject({ code: "ENOENT" });
    second.assertCurrent();
    await expect(fs.access(second.env.GH_CONFIG_DIR)).resolves.toBeUndefined();
  });
  it("propagates unavailable selected credentials without borrowing an App account", async () => {
    mocks.prepare.mockRejectedValue(new Error("selected identity unavailable"));
    await expect(prepare()).rejects.toThrow("selected identity unavailable");
  });
  it("fences a closed grant but retains its profile until the execution owner joins cleanup", async () => {
    const selected = grant();
    mocks.prepare.mockResolvedValue(selected);
    const prepared = (await prepare())!;
    await selected.revoke();
    expect(prepared.signal?.aborted).toBe(true);
    expect(() => prepared.assertCurrent()).toThrow();
    await expect(fs.access(prepared.env.GH_CONFIG_DIR)).resolves.toBeUndefined();
    await prepared.dispose();
    await expect(fs.access(prepared.env.GH_CONFIG_DIR)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("joins in-flight canonical refresh before deleting the private profile", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const refreshed = createDeferredCore<{ token: string }>();
    mocks.prepare.mockImplementation(async () => grant(() => refreshed.promise));
    const prepared = (await prepare())!;
    await vi.advanceTimersByTimeAsync(60_000);
    let closed = false;
    const cleanup = prepared.dispose().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(fs.access(prepared.env.GH_CONFIG_DIR)).resolves.toBeUndefined();
    refreshed.resolve({ token: "synthetic-rotated-selected-token" });
    await cleanup;
    expect(() => prepared.assertCurrent()).toThrow();
    await expect(fs.access(prepared.env.GH_CONFIG_DIR)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
