import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import * as processExec from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cloneProjectCheckout,
  ensureProjectCheckoutCommit,
  ProjectCloneError,
  refreshProjectCheckout,
  resolveProjectCheckoutBase,
} from "./project-clone-runtime-api.js";
import { parseProjectGitUrl } from "./project-url-api.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const createCommandResult = (): processExec.SpawnResult => ({
  stdout: "",
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
});
function listen(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected the bound local Git HTTP address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}
const closeServer = (server: http.Server) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

it.each([
  ["https://github.com/openclaw/openclaw.git", "ghe.example.test"],
  ["file:///tmp/openclaw.git"],
  ["ssh://git@github.com:2222/openclaw/openclaw.git"],
  ["/tmp/openclaw"],
  ["--upload-pack=touch-pwned"],
  ["https://token@github.com/openclaw/openclaw.git"],
  ["https://github.com/openclaw/openclaw.git?config=evil"],
  ["https://github.com/openclaw/openclaw/extra"],
  ["git@github.com:../../tmp/openclaw.git"],
  ["https://github.com/openclaw/openclaw.git --config=evil"],
])("rejects unsafe project clone URL %s", (input, host?: string) => {
  expect(parseProjectGitUrl(input, host)).toBeNull();
});

describe("GitHub project transport", () => {
  let root: string;
  beforeEach(() => {
    root = tempDirs.make("github-project-transport-");
  });
  afterEach(() => vi.restoreAllMocks());
  function git(repo: string, ...args: string[]) {
    return execFileAsync("git", ["-C", repo, ...args]);
  }
  async function gitText(repo: string, ...args: string[]) {
    return (await git(repo, ...args)).stdout.trim();
  }
  async function commitFile(repo: string, file: string, content: string) {
    await fs.writeFile(path.join(repo, file), content);
    await git(repo, "add", file);
    await git(repo, "commit", "-m", file);
    return gitText(repo, "rev-parse", "HEAD");
  }
  async function initializeRepository(
    parent: string,
    name: string,
    objectFormat: "sha1" | "sha256" = "sha1",
  ): Promise<string> {
    const repo = path.join(parent, name);
    await fs.mkdir(repo, { recursive: true });
    await execFileAsync("git", ["init", "-b", "main", `--object-format=${objectFormat}`, repo]);
    await git(repo, "config", "user.name", "OpenClaw Tests");
    await git(repo, "config", "user.email", "tests@openclaw.invalid");
    await commitFile(repo, "README.md", `${name}\n`);
    return fs.realpath(repo);
  }
  async function cloneFixture(objectFormat: "sha1" | "sha256" = "sha1") {
    const source = await initializeRepository(root, "source", objectFormat);
    const target = path.join(root, "managed", "fixture");
    await cloneProjectCheckout({ url: source, target });
    return { source, target };
  }
  function expectRef(repo: string, ref: string) {
    return expect(git(repo, "rev-parse", "--verify", ref));
  }
  it("scopes private clone and refresh credentials to the repository origin", async ({
    onTestFinished,
  }) => {
    const checkout = await initializeRepository(root, "checkout");
    const token = "synthetic-project-token";
    const runCommand = processExec.runCommandWithTimeout;
    const runGit = processExec.executeGitCommand;
    const networkCalls: Array<[string[], Parameters<typeof processExec.runCommandWithTimeout>[1]]> =
      [];
    const commandSpy = vi.spyOn(processExec, "runCommandWithTimeout");
    const gitSpy = vi.spyOn(processExec, "executeGitCommand");
    commandSpy.mockImplementation(async (argv, commandOptions) => {
      if (argv.includes("clone")) {
        networkCalls.push([argv, typeof commandOptions === "object" ? commandOptions : {}]);
        return createCommandResult();
      }
      return await runCommand(argv, commandOptions);
    });
    gitSpy.mockImplementation(async (cwd, argv, commandOptions) => {
      if (argv.includes("fetch")) {
        networkCalls.push([argv, commandOptions ?? {}]);
        return { ...createCommandResult(), timeoutMs: 0 };
      }
      return await runGit(cwd, argv, commandOptions);
    });
    onTestFinished(() => {
      commandSpy.mockRestore();
      gitSpy.mockRestore();
    });
    for (const host of ["ghe.example.test", "github.com"]) {
      await cloneProjectCheckout(
        { url: `https://${host}/acme/repository.git`, target: path.join(root, host) },
        { token },
      );
    }
    await refreshProjectCheckout(
      { target: checkout, url: "https://ghe.example.test/acme/enterprise.git" },
      { token },
    );

    const networkEnvs = networkCalls.map(([, commandOptions]) =>
      typeof commandOptions === "object" ? commandOptions?.env : undefined,
    );
    expect(networkEnvs.map((env) => env?.GIT_CONFIG_KEY_0)).toEqual([
      "http.https://ghe.example.test/.extraHeader",
      "http.https://github.com/.extraHeader",
      "http.https://ghe.example.test/.extraHeader",
    ]);
    expect(networkEnvs.map((env) => env?.GIT_CONFIG_COUNT)).toEqual(["1", "1", "1"]);
    expect(networkCalls.flatMap(([argv]) => argv)).not.toContain(token);
    const unrelatedOrigin = await runCommand(
      [
        "git",
        "config",
        "--get-urlmatch",
        "http.extraHeader",
        "https://unrelated.example/acme/repository.git",
      ],
      { env: networkEnvs[0] },
    );
    expect(unrelatedOrigin).toMatchObject({ code: 1, stdout: "" });
  });

  it("resolves fresh authenticated defaults after advancement and rename without moving local HEAD", async ({
    onTestFinished,
  }) => {
    const { source, target } = await cloneFixture();
    const initial = await gitText(target, "rev-parse", "HEAD");
    const url = "https://ghe.example.test/acme/private.git";
    const token = "synthetic-base-token";
    const runCommand = processExec.executeGitCommand;
    const network: NodeJS.ProcessEnv[] = [];
    const command = vi.spyOn(processExec, "executeGitCommand");
    onTestFinished(() => command.mockRestore());
    command.mockImplementation(async (cwd, argv, runOptions) => {
      if (argv.includes(url)) {
        expect(argv).not.toContain(token);
        if (!runOptions?.env) {
          throw new Error("Authenticated Git transport requires its scoped environment");
        }
        network.push(runOptions.env);
      }
      return await runCommand(
        cwd,
        argv.map((arg) => (arg === url ? source : arg)),
        runOptions,
      );
    });
    for (const branch of ["main", "renamed-default"]) {
      if (branch !== "main") {
        await git(source, "branch", "-m", branch);
      }
      const commit = await commitFile(source, branch + ".txt", branch + "\n");
      await expect(resolveProjectCheckoutBase({ url, target }, { token })).resolves.toEqual({
        commit,
        ref: `origin/${branch}`,
      });
      expect(await gitText(target, "symbolic-ref", "refs/remotes/origin/HEAD")).toBe(
        `refs/remotes/origin/${branch}`,
      );
      expect(await gitText(target, "rev-parse", `origin/${branch}`)).toBe(commit);
      expect(await gitText(target, "rev-parse", "HEAD")).toBe(initial);
    }
    const beforeExplicit = network.length;
    await expect(
      resolveProjectCheckoutBase({ url, target, ref: "HEAD" }, { token }),
    ).resolves.toEqual({
      commit: initial,
      ref: "HEAD",
    });
    expect(network).toHaveLength(beforeExplicit);
    for (const ref of ["refs/heads/main:refs/heads/overwritten", "+new-base"]) {
      await expect(
        resolveProjectCheckoutBase({ url, target, ref }, { token }),
      ).rejects.toMatchObject({
        failure: "clone_failed",
      });
    }
    expect(network).toHaveLength(beforeExplicit);
    await git(source, "branch", "new-base");
    await git(source, "checkout", "-b", "+new-base");
    const explicit = await commitFile(source, "explicit.txt", "explicit\n");
    await expect(
      resolveProjectCheckoutBase({ url, target, ref: "origin/+new-base" }, { token }),
    ).resolves.toEqual({ commit: explicit, ref: "origin/+new-base" });
    expect(network.length).toBeGreaterThan(beforeExplicit);
    for (const env of network) {
      expect(env.GIT_CONFIG_KEY_0).toBe("http.https://ghe.example.test/.extraHeader");
      expect(env.GIT_CONFIG_VALUE_0).toBe(
        `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      );
    }
  });

  it.each(["sha256", ...(process.platform !== "win32" ? (["sha1"] as const) : [])] as const)(
    "refreshes managed %s refs (SHA-1 with a forbidden checkout hook)",
    async (format) => {
      const { source, target } = await cloneFixture(format);
      const marker = path.join(root, "hook-ran");
      if (format === "sha1") {
        const hooks = path.join(target, "git-hooks");
        await fs.mkdir(hooks);
        const hook = path.join(hooks, "reference-transaction");
        await fs.writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
        await fs.chmod(hook, 0o755);
        await git(target, "config", "core.hooksPath", hooks);
      }
      const sourceHead = await commitFile(source, "later.txt", "later\n");
      await refreshProjectCheckout({ url: source, target });

      if (format === "sha1") {
        await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await gitText(target, "rev-parse", "origin/main")).toBe(sourceHead);
    },
  );

  it("negotiates pinned partial-clone commits and preserves filtering during refresh", async () => {
    const source = await initializeRepository(root, "source");
    await git(source, "config", "uploadpack.allowFilter", "true");
    const target = path.join(root, "partial");
    const url = pathToFileURL(source).href;
    await git(root, "clone", "--filter=blob:none", "--no-checkout", url, target);
    await git(target, "config", `remote.${url}.promisor`, "true");
    await git(target, "config", `remote.${url}.partialclonefilter`, "blob:none");
    const base = await gitText(target, "rev-parse", "HEAD");
    const packs = path.join(target, ".git", "objects", "pack");
    const before = new Set(await fs.readdir(packs));
    const commit = await commitFile(source, "later.txt", "keep this blob lazy\n");

    // A missing pinned SHA must use negotiated transport, not cat-file's lazy
    // fetch of the whole commit ancestry. Caller environment cannot enable it.
    await ensureProjectCheckoutCommit(
      { url, target, commit },
      { env: { ...process.env, GIT_NO_LAZY_FETCH: "0" } },
    );
    const added = (await fs.readdir(packs)).filter(
      (name) => name.endsWith(".idx") && !before.has(name),
    );
    expect(added).toHaveLength(1);
    const indexed = (await git(target, "verify-pack", "-v", path.join(packs, added[0]!))).stdout;
    expect(indexed).toContain(`${commit} commit`);
    expect(indexed).not.toContain(`${base} commit`);
    expect(await gitText(target, "rev-parse", "HEAD")).toBe(base);
    expect(await gitText(target, "cat-file", "-t", commit)).toBe("commit");
    await ensureProjectCheckoutCommit(
      { url, target, commit },
      { env: { ...process.env, GIT_ALLOW_PROTOCOL: "" } },
    );
    const refreshed = await commitFile(source, "refresh.txt", "keep refreshed blobs lazy\n");
    const refreshedBlob = await gitText(source, "rev-parse", "HEAD:refresh.txt");
    await refreshProjectCheckout({ url, target });
    expect(await gitText(target, "rev-parse", "origin/main")).toBe(refreshed);

    await expect(
      execFileAsync("git", ["-C", target, "cat-file", "-e", refreshedBlob], {
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
      }),
    ).rejects.toMatchObject({ code: 1 });
    expect((await git(target, "show", `${refreshed}:refresh.txt`)).stdout).toBe(
      "keep refreshed blobs lazy\n",
    );
  });

  it.each([
    ["initial", false],
    ["fetched", false],
    ["initial", true],
    ["fetched", true],
  ] as const)("refreshes %s refs atomically (truncated: %s)", async (inventory, truncated) => {
    const { source, target } = await cloneFixture();
    const commit = await gitText(target, "rev-parse", "HEAD");
    // Each record is 128 bytes, so truncation can leave only complete records.
    const names = Array.from({ length: truncated ? 65_537 : 7_850 }, (_, index) =>
      String(index).padStart(65, "0"),
    );
    const refs = (prefix: string, branches = names) =>
      branches.map((name) => `${commit} ${prefix}/${name}\n`).join("");
    const packed = path.join(target, ".git", "packed-refs");
    const initial = inventory === "initial" ? names : names.slice(0, 1);
    const original = refs("refs/remotes/origin", initial);
    if (truncated || inventory === "initial") {
      await fs.writeFile(packed, original);
    }
    if (!truncated || inventory === "fetched") {
      await fs.writeFile(path.join(source, ".git", "packed-refs"), refs("refs/heads"));
    }
    if (truncated) {
      await expect(refreshProjectCheckout({ url: source, target })).rejects.toThrow(
        "ref inventory exceeded the 8 MiB refresh limit",
      );
      await expectRef(target, `origin/${names[0]}`).resolves.toMatchObject({
        stdout: `${commit}\n`,
      });
      expect(await fs.readFile(packed, "utf8")).toBe(original);
    } else {
      await git(target, "update-ref", "refs/remotes/origin/deleted", commit);
      const next = await commitFile(source, "later.txt", "new upstream commit\n");
      await refreshProjectCheckout({ url: source, target });
      expect(await gitText(target, "rev-parse", "origin/main")).toBe(next);
      expect(await gitText(target, "rev-parse", `origin/${names.at(-1)}`)).toBe(commit);
      await expectRef(target, "origin/deleted").rejects.toMatchObject({ code: 128 });
      expect(await gitText(target, "rev-parse", "HEAD")).toBe(commit);
    }
  });

  it("classifies authentication failures without returning credential material", async ({
    onTestFinished,
  }) => {
    const token = "github_pat_secret-fixture-value";
    const server = http.createServer((_request, response) => {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Git"' });
      response.end("authentication required");
    });
    onTestFinished(() => closeServer(server));
    const url = `${await listen(server)}/private.git`;
    const error = await cloneProjectCheckout(
      { url, target: path.join(root, "private") },
      { token },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProjectCloneError);
    expect(error).toMatchObject({ failure: "auth_required" });
    expect((error as Error).message).not.toContain(token);
    expect((error as Error).message).toContain(
      "plugins.entries.github-repositories.config.service.token",
    );
    expect((error as Error).message).toContain("shared Gateway process environment");
  });
  it("ignores checkout URL rewrites while refreshing the recorded project", async () => {
    const { source, target: checkout } = await cloneFixture();
    await git(source, "branch", "expected-base");
    const unrelated = await initializeRepository(root, "unrelated");
    await git(unrelated, "branch", "injected-base");
    await git(checkout, "config", `url.${unrelated}.insteadOf`, source);

    await expect(
      refreshProjectCheckout({ target: checkout, url: source }),
    ).resolves.toBeUndefined();
    await expectRef(checkout, "refs/remotes/origin/expected-base").resolves.toBeDefined();
    await expectRef(checkout, "refs/remotes/origin/injected-base").rejects.toBeDefined();
  });
});
