import { describe, expect, it, vi } from "vitest";
import { runUpstreamSync } from "./upstream-sync.mjs";

function createCaptureStream() {
  let output = "";
  return {
    toString() {
      return output;
    },
    write(chunk: unknown) {
      output += String(chunk);
      return true;
    },
  };
}

function createExecMock(
  resolver: (
    argv: string[],
    options?: { cwd?: string },
  ) => Promise<{ code: number | null; stderr: string; stdout: string }>,
) {
  const calls: string[][] = [];
  const exec = vi.fn(async (argv: string[], options?: { cwd?: string }) => {
    calls.push(argv);
    return await resolver(argv, options);
  });
  return { calls, exec };
}

describe("upstream-sync", () => {
  it("exits cleanly when upstream has no commits ahead of origin/main", async () => {
    const { calls, exec } = createExecMock(async (argv) => {
      const command = argv.join(" ");
      if (command === "git rev-parse --show-toplevel") {
        return { code: 0, stdout: "/tmp/repo\n", stderr: "" };
      }
      if (command === "git remote get-url origin") {
        return { code: 0, stdout: "https://github.com/nathan-widjaja/openclaw.git\n", stderr: "" };
      }
      if (command === "git fetch --quiet origin main") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git fetch --quiet upstream main") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git rev-list --count origin/main..upstream/main") {
        return { code: 0, stdout: "0\n", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const result = await runUpstreamSync(
      ["--open-pr"],
      { stderr, stdout },
      {
        cwd: "/tmp/repo",
        env: {},
        exec,
        now: () => new Date("2026-04-06T00:00:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      action: "noop",
      exitCode: 0,
      prUrl: null,
    });
    expect(stdout.toString()).toContain("No upstream commits ahead of origin/main.");
    expect(stderr.toString()).toBe("");
    expect(calls.some((argv) => argv[0] === "gh")).toBe(false);
  });

  it("creates a sync PR after a clean merge and verification pass", async () => {
    const branchName = "sync/upstream-2026-04-06";
    const { calls, exec } = createExecMock(async (argv) => {
      const command = argv.join(" ");
      if (command === "git rev-parse --show-toplevel") {
        return { code: 0, stdout: "/tmp/repo\n", stderr: "" };
      }
      if (command === "git remote get-url origin") {
        return { code: 0, stdout: "https://github.com/nathan-widjaja/openclaw.git\n", stderr: "" };
      }
      if (command === "git fetch --quiet origin main") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git fetch --quiet upstream main") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git rev-list --count origin/main..upstream/main") {
        return { code: 0, stdout: "3\n", stderr: "" };
      }
      if (
        command ===
        "gh pr list --repo nathan-widjaja/openclaw --base main --state open --json number,url,headRefName,title,body,isCrossRepository"
      ) {
        return { code: 0, stdout: "[]", stderr: "" };
      }
      if (command === `git checkout -B ${branchName} origin/main`) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git merge --no-edit upstream/main") {
        return { code: 0, stdout: "Merge made by the 'ort' strategy.\n", stderr: "" };
      }
      if (command === "git rev-parse origin/main") {
        return { code: 0, stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n", stderr: "" };
      }
      if (command === "git rev-parse upstream/main") {
        return { code: 0, stdout: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", stderr: "" };
      }
      if (command === "git rev-parse HEAD") {
        return { code: 0, stdout: "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
      }
      if (command === "git log --oneline --no-merges origin/main..upstream/main") {
        return { code: 0, stdout: "bbbbbbb upstream change\n", stderr: "" };
      }
      if (command === "git log --oneline --no-merges upstream/main..HEAD") {
        return { code: 0, stdout: "1111111 fork delta\n", stderr: "" };
      }
      if (
        command ===
        "git diff --name-only origin/main..upstream/main -- package.json pnpm-lock.yaml package-lock.json bun.lock bun.lockb"
      ) {
        return { code: 0, stdout: "package.json\npnpm-lock.yaml\n", stderr: "" };
      }
      if (command === "pnpm install --frozen-lockfile") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "pnpm build") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        command ===
        "pnpm test src/cli/daemon-cli-compat.test.ts src/cli/live-cli.test.ts src/cli/live-control.test.ts"
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git diff --check") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === `git push origin HEAD:${branchName}`) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "create") {
        expect(argv).toContain("--repo");
        expect(argv).toContain("nathan-widjaja/openclaw");
        return {
          code: 0,
          stdout: "https://github.com/nathan-widjaja/openclaw/pull/2\n",
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const result = await runUpstreamSync(
      ["--open-pr"],
      { stderr, stdout },
      {
        cwd: "/tmp/repo",
        env: {},
        exec,
        now: () => new Date("2026-04-06T00:00:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      action: "created",
      branchName,
      exitCode: 0,
      prUrl: "https://github.com/nathan-widjaja/openclaw/pull/2",
    });
    expect(stdout.toString()).toContain("Upstream sync PR ready");
    expect(stderr.toString()).toBe("");
    expect(calls.some((argv) => argv.join(" ") === `git push origin HEAD:${branchName}`)).toBe(
      true,
    );
  });

  it("ignores cross-repository sync PRs when picking the managed branch", async () => {
    const branchName = "sync/upstream-2026-04-06";
    const { calls, exec } = createExecMock(async (argv) => {
      const command = argv.join(" ");
      if (command === "git rev-parse --show-toplevel") {
        return { code: 0, stdout: "/tmp/repo\n", stderr: "" };
      }
      if (command === "git remote get-url origin") {
        return { code: 0, stdout: "https://github.com/nathan-widjaja/openclaw.git\n", stderr: "" };
      }
      if (command === "git fetch --quiet origin main") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git fetch --quiet upstream main") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git rev-list --count origin/main..upstream/main") {
        return { code: 0, stdout: "3\n", stderr: "" };
      }
      if (
        command ===
        "gh pr list --repo nathan-widjaja/openclaw --base main --state open --json number,url,headRefName,title,body,isCrossRepository"
      ) {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              body: "",
              headRefName: "sync/upstream-2026-03-30",
              isCrossRepository: true,
              number: 99,
              title: "foreign sync branch",
              url: "https://github.com/example/openclaw/pull/99",
            },
          ]),
          stderr: "",
        };
      }
      if (command === `git checkout -B ${branchName} origin/main`) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git merge --no-edit upstream/main") {
        return { code: 0, stdout: "Merge made by the 'ort' strategy.\n", stderr: "" };
      }
      if (command === "git rev-parse origin/main") {
        return { code: 0, stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n", stderr: "" };
      }
      if (command === "git rev-parse upstream/main") {
        return { code: 0, stdout: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", stderr: "" };
      }
      if (command === "git rev-parse HEAD") {
        return { code: 0, stdout: "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
      }
      if (command === "git log --oneline --no-merges origin/main..upstream/main") {
        return { code: 0, stdout: "bbbbbbb upstream change\n", stderr: "" };
      }
      if (command === "git log --oneline --no-merges upstream/main..HEAD") {
        return { code: 0, stdout: "1111111 fork delta\n", stderr: "" };
      }
      if (
        command ===
        "git diff --name-only origin/main..upstream/main -- package.json pnpm-lock.yaml package-lock.json bun.lock bun.lockb"
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "pnpm install --frozen-lockfile") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "pnpm build") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        command ===
        "pnpm test src/cli/daemon-cli-compat.test.ts src/cli/live-cli.test.ts src/cli/live-control.test.ts"
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git diff --check") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === `git push origin HEAD:${branchName}`) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "create") {
        expect(argv).toContain("--repo");
        expect(argv).toContain("nathan-widjaja/openclaw");
        return {
          code: 0,
          stdout: "https://github.com/nathan-widjaja/openclaw/pull/2\n",
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const result = await runUpstreamSync(
      ["--open-pr"],
      { stderr, stdout },
      {
        cwd: "/tmp/repo",
        env: {},
        exec,
        now: () => new Date("2026-04-06T00:00:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      action: "created",
      branchName,
      exitCode: 0,
      prUrl: "https://github.com/nathan-widjaja/openclaw/pull/2",
    });
    expect(
      calls.some((argv) => argv.join(" ") === "git fetch --quiet origin sync/upstream-2026-03-30"),
    ).toBe(false);
    expect(
      calls.some(
        (argv) =>
          argv.join(" ") ===
          "git checkout -B sync/upstream-2026-03-30 origin/sync/upstream-2026-03-30",
      ),
    ).toBe(false);
  });

  it("fails cleanly when the upstream merge conflicts", async () => {
    const { calls, exec } = createExecMock(async (argv) => {
      const command = argv.join(" ");
      if (command === "git rev-parse --show-toplevel") {
        return { code: 0, stdout: "/tmp/repo\n", stderr: "" };
      }
      if (command === "git remote get-url origin") {
        return { code: 0, stdout: "https://github.com/nathan-widjaja/openclaw.git\n", stderr: "" };
      }
      if (command === "git fetch --quiet origin main") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git fetch --quiet upstream main") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git rev-list --count origin/main..upstream/main") {
        return { code: 0, stdout: "2\n", stderr: "" };
      }
      if (
        command ===
        "gh pr list --repo nathan-widjaja/openclaw --base main --state open --json number,url,headRefName,title,body,isCrossRepository"
      ) {
        return { code: 0, stdout: "[]", stderr: "" };
      }
      if (command === "git checkout -B sync/upstream-2026-04-06 origin/main") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git merge --no-edit upstream/main") {
        return { code: 1, stdout: "", stderr: "CONFLICT (content): merge conflict" };
      }
      if (command === "git merge --abort") {
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const result = await runUpstreamSync(
      ["--open-pr"],
      { stderr, stdout },
      {
        cwd: "/tmp/repo",
        env: {},
        exec,
        now: () => new Date("2026-04-06T00:00:00.000Z"),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.action).toBe("failed");
    expect(stderr.toString()).toContain("Could not merge upstream/main");
    expect(calls.some((argv) => argv[0] === "gh" && argv[2] === "create")).toBe(false);
  });

  it("fails before push when verification does not pass", async () => {
    const { calls, exec } = createExecMock(async (argv) => {
      const command = argv.join(" ");
      if (command === "git rev-parse --show-toplevel") {
        return { code: 0, stdout: "/tmp/repo\n", stderr: "" };
      }
      if (command === "git remote get-url origin") {
        return { code: 0, stdout: "https://github.com/nathan-widjaja/openclaw.git\n", stderr: "" };
      }
      if (command === "git fetch --quiet origin main") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git fetch --quiet upstream main") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git rev-list --count origin/main..upstream/main") {
        return { code: 0, stdout: "1\n", stderr: "" };
      }
      if (
        command ===
        "gh pr list --repo nathan-widjaja/openclaw --base main --state open --json number,url,headRefName,title,body,isCrossRepository"
      ) {
        return { code: 0, stdout: "[]", stderr: "" };
      }
      if (command === "git checkout -B sync/upstream-2026-04-06 origin/main") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git merge --no-edit upstream/main") {
        return { code: 0, stdout: "Merge made by the 'ort' strategy.\n", stderr: "" };
      }
      if (command === "git rev-parse origin/main") {
        return { code: 0, stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n", stderr: "" };
      }
      if (command === "git rev-parse upstream/main") {
        return { code: 0, stdout: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", stderr: "" };
      }
      if (command === "git rev-parse HEAD") {
        return { code: 0, stdout: "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
      }
      if (command === "git log --oneline --no-merges origin/main..upstream/main") {
        return { code: 0, stdout: "bbbbbbb upstream change\n", stderr: "" };
      }
      if (command === "git log --oneline --no-merges upstream/main..HEAD") {
        return { code: 0, stdout: "1111111 fork delta\n", stderr: "" };
      }
      if (
        command ===
        "git diff --name-only origin/main..upstream/main -- package.json pnpm-lock.yaml package-lock.json bun.lock bun.lockb"
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "pnpm install --frozen-lockfile") {
        return { code: 1, stdout: "", stderr: "install failed" };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const result = await runUpstreamSync(
      ["--open-pr"],
      { stderr, stdout },
      {
        cwd: "/tmp/repo",
        env: {},
        exec,
        now: () => new Date("2026-04-06T00:00:00.000Z"),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.action).toBe("failed");
    expect(stderr.toString()).toContain("Verification failed");
    expect(calls.some((argv) => argv[0] === "git" && argv[1] === "push")).toBe(false);
  });

  it("uses a temporary worktree for dry-run previews", async () => {
    const { calls, exec } = createExecMock(async (argv, options) => {
      const command = argv.join(" ");
      if (command === "git rev-parse --show-toplevel") {
        return { code: 0, stdout: "/tmp/repo\n", stderr: "" };
      }
      if (command === "git remote get-url origin") {
        return { code: 0, stdout: "https://github.com/nathan-widjaja/openclaw.git\n", stderr: "" };
      }
      if (command === "git fetch --quiet origin main") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git fetch --quiet upstream main") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git rev-list --count origin/main..upstream/main") {
        return { code: 0, stdout: "1\n", stderr: "" };
      }
      if (
        command ===
        "gh pr list --repo nathan-widjaja/openclaw --base main --state open --json number,url,headRefName,title,body,isCrossRepository"
      ) {
        return { code: 0, stdout: "[]", stderr: "" };
      }
      if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "add") {
        expect(argv[3]).toBe("--quiet");
        expect(argv[4]).toBe("--detach");
        expect(argv[6]).toBe("origin/main");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git merge --no-edit upstream/main") {
        expect(options?.cwd).toContain("openclaw-upstream-sync-");
        return { code: 0, stdout: "Merge made by the 'ort' strategy.\n", stderr: "" };
      }
      if (command === "git rev-parse origin/main") {
        return { code: 0, stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n", stderr: "" };
      }
      if (command === "git rev-parse upstream/main") {
        return { code: 0, stdout: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", stderr: "" };
      }
      if (command === "git rev-parse HEAD") {
        expect(options?.cwd).toContain("openclaw-upstream-sync-");
        return { code: 0, stdout: "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
      }
      if (command === "git log --oneline --no-merges origin/main..upstream/main") {
        return { code: 0, stdout: "bbbbbbb upstream change\n", stderr: "" };
      }
      if (command === "git log --oneline --no-merges upstream/main..HEAD") {
        expect(options?.cwd).toContain("openclaw-upstream-sync-");
        return { code: 0, stdout: "1111111 fork delta\n", stderr: "" };
      }
      if (
        command ===
        "git diff --name-only origin/main..upstream/main -- package.json pnpm-lock.yaml package-lock.json bun.lock bun.lockb"
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "remove") {
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const result = await runUpstreamSync(
      ["--open-pr", "--dry-run"],
      { stderr, stdout },
      {
        cwd: "/tmp/repo",
        env: {},
        exec,
        now: () => new Date("2026-04-06T00:00:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      action: "prepared",
      branchName: "sync/upstream-2026-04-06",
      exitCode: 0,
      prUrl: null,
    });
    expect(stdout.toString()).toContain("left the current checkout untouched");
    expect(calls.some((argv) => argv[0] === "git" && argv[1] === "checkout")).toBe(false);
    expect(calls.some((argv) => argv[0] === "git" && argv[1] === "push")).toBe(false);
  });
});
