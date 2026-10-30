import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { existsSync, realpathSync } from "node:fs";
import { mkdir, writeFile, readFile, rm, rename, symlink } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { Check } from "typebox/value";
import { expect, it, vi } from "vitest";
import { GitHistory } from "./git-history.js";
import { SqliteIdentityStore } from "./identity-store.js";
import { Receipt, GitStatus } from "./mutation-contract.js";
import { KnowledgeStorage } from "./storage.js";
import {
  afterTest,
  childEvalArgs,
  createVault,
  plainAccess,
  sourceModule,
  useTestTempDirs,
  defaultOrder,
} from "./test-support.js";

const tempDirs = useTestTempDirs();

const git = (root: any, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trimEnd();
const draft = () => ({
  requestId: randomUUID(),
  title: "History",
  type: "note",
  body: "First bytes.\n",
});
async function fixture() {
  const base = tempDirs.make("knowledge-git-");
  const { root, config } = await createVault(base);
  const access = plainAccess();
  const store = new SqliteIdentityStore(config.statePath);
  const service = new KnowledgeStorage(config, store);
  const read = async (id: any) =>
    service.run(access, async (vault) => (await vault.scan()).records.find((r) => r.id === id));
  return { base, root, config, access, store, service, read };
}
const edit = (record: any) => ({
  requestId: randomUUID(),
  id: record.id,
  expectedRevision: record.revision,
  expectedHash: record.hash,
  title: record.title,
  body: "Second bytes.\n",
});

it("default repository, exact grouped content, clean index, actor, and one commit per publication", async () => {
  const f = await fixture(),
    input = { ...draft(), source: { text: "Evidence bytes\n", attribution: "Source" } };
  // Git must not hold the operational database writer while spawning subprocesses.
  let checkedWriter = false;
  const service = new KnowledgeStorage(f.config, f.store, (stage) => {
    if (stage === "before-git-ref") {
      f.store.withDatabase((db) => {
        db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK");
      });
      checkedWriter = true;
    }
  });
  const saved = await service.save(input, f.access, "operator");
  expect(Check(Receipt, saved)).toBeTruthy();
  expect(saved.git!.state, JSON.stringify(saved)).toBe("committed");
  expect(checkedWriter).toBe(true);
  expect(git(f.root, "rev-list", "--count", "HEAD")).toBe("1");
  const sourceId = (await f.read(saved.id))!.metadata.evidence![0]!.source;
  expect(sourceId).toMatch(/^[a-f0-9]{64}$/);
  expect(
    git(f.root, "ls-tree", "-r", "--name-only", "HEAD").split("\n").toSorted(defaultOrder),
  ).toStrictEqual(
    [
      `private/${saved.path}`,
      `private/artifacts/${input.requestId}.txt`,
      `private/artifacts/sources/${sourceId}.json`,
    ].toSorted(defaultOrder),
  );
  expect(
    execFileSync("git", ["-C", f.root, "show", `HEAD:private/${saved.path}`], { encoding: "utf8" }),
  ).toBe(await readFile(path.join(f.root, "private", saved.path), "utf8"));
  expect(git(f.root, "diff", "--cached", "--name-only")).toBe("");
  expect(git(f.root, "log", "-1", "--format=%B")).toMatch(/operator/);
  const next = await f.service.save(edit(await f.read(saved.id)), f.access, "agent");
  expect(next.git!.state).toBe("committed");
  expect(git(f.root, "rev-list", "--count", "HEAD")).toBe("2");
  expect(await new KnowledgeStorage(f.config).save(input, f.access, "operator")).toStrictEqual(
    saved,
  );
  expect(git(f.root, "rev-list", "--count", "HEAD")).toBe("2");
  expect(Check(GitStatus, f.service.history(f.access, {}).git)).toBeTruthy();
  expect(git(f.root, "remote")).toBe("");
});

it("missing Git is nonfatal and later availability catches up every version in order", async () => {
  const f = await fixture();
  const unavailable = new KnowledgeStorage(
    f.config,
    f.store,
    undefined,
    new GitHistory(f.root, path.join(f.base, "missing-git")),
  );
  const input = draft(),
    first = await unavailable.save(input, f.access, "agent");
  expect(first.state).toBe("published");
  expect(first.git!.state).toBe("unavailable");
  expect(existsSync(path.join(f.root, ".git"))).toBe(false);
  const record = await unavailable.run(f.access, async (vault) => (await vault.scan()).records[0]);
  const second = await unavailable.save(edit(record), f.access, "agent");
  expect(second.state).toBe("published");
  const resumed = f.service.resume(f.access, input.requestId);
  expect(resumed.git!.state).toBe("committed");
  expect(git(f.root, "rev-list", "--count", "HEAD")).toBe("2");
  expect(git(f.root, "show", `HEAD^:private/${first.path}`)).toMatch(/First bytes/);
  expect(git(f.root, "show", `HEAD:private/${first.path}`)).toMatch(/Second bytes/);
  expect(f.service.history(f.access, {}).git.pending).toBe(0);
});

it("existing repo staging, unrelated dirty files, and same-path staged bytes survive", async () => {
  const f = await fixture(),
    first = await f.service.save(draft(), f.access, "agent");
  await writeFile(path.join(f.root, "unrelated.txt"), "staged content");
  git(f.root, "add", "unrelated.txt");
  await writeFile(path.join(f.root, "unrelated.txt"), "unstaged content");
  const record = await f.read(first.id),
    full = path.join(f.root, "private", first.path);
  await writeFile(full, record!.raw.replace("First bytes.", "Manually staged."));
  git(f.root, "add", `private/${first.path}`);
  await writeFile(full, record!.raw);
  const receipt = await f.service.save(edit(record), f.access, "agent");
  expect(receipt.git!.state).toBe("committed");
  expect(git(f.root, "show", ":unrelated.txt")).toBe("staged content");
  expect(git(f.root, "show", `:private/${first.path}`)).toMatch(/Manually staged/);
  expect(await readFile(path.join(f.root, "unrelated.txt"), "utf8")).toBe("unstaged content");
  expect(git(f.root, "ls-tree", "-r", "--name-only", "HEAD")).toBe(`private/${first.path}`);
});

it("materializes checkpoint content once while updating both the commit and working index", async () => {
  const f = await fixture();
  const changes = ["one", "two", "three"].map((name) => ({
    path: `private/${name}.md`,
    raw: `Synthetic checkpoint ${name}\n`,
  }));
  const writes = vi.spyOn(fs, "writeFileSync");
  syncBuiltinESMExports();
  afterTest(() => {
    writes.mockRestore();
    syncBuiltinESMExports();
  });
  new GitHistory(f.root).checkpoint({
    token: "a".repeat(64),
    changes,
    actor: "synthetic test",
    at: "2026-01-01T00:00:00Z",
  });
  for (const { path: file, raw } of changes) {
    expect(writes.mock.calls.filter(([, content]) => content === raw)).toHaveLength(1);
    expect(git(f.root, "show", `HEAD:${file}`)).toBe(raw.trimEnd());
    expect(git(f.root, "show", `:${file}`)).toBe(raw.trimEnd());
  }
  expect(git(f.root, "diff", "--cached", "--name-only")).toBe("");
});

for (const stage of ["before-git-ref", "after-git-ref"]) {
  it(`checkpoint failure at ${stage} is visible and retries without duplicate commits`, async () => {
    const f = await fixture(),
      input = draft();
    const broken = new KnowledgeStorage(f.config, f.store, (where) => {
      if (where === stage) {
        throw new Error("injected checkpoint failure");
      }
    });
    const receipt = await broken.save(input, f.access, "agent");
    expect(receipt.state).toBe("published");
    expect(receipt.git!.state).toBe("pending");
    expect(f.service.resume(f.access, input.requestId).git!.state).toBe("committed");
    expect(git(f.root, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(f.root, "diff", "--cached", "--name-only")).toBe("");
  });
}

it("revoked access after a Git commit leaves its acknowledgement pending for an authorized retry", async () => {
  const f = await fixture(),
    input = draft();
  let revoked = false;
  const service = new KnowledgeStorage(f.config, f.store, (stage) => {
    if (stage === "after-git-ref") {
      revoked = true;
    }
  });
  await expect(
    service.save(
      input,
      {
        ...f.access,
        assertCurrent() {
          if (revoked) {
            throw new Error("access revoked");
          }
        },
      },
      "agent",
    ),
  ).rejects.toThrow("access revoked");
  expect(f.service.history(f.access, {}).git.pending).toBe(1);
  expect(f.service.resume(f.access, input.requestId).git!.state).toBe("committed");
  expect(git(f.root, "rev-list", "--count", "HEAD")).toBe("1");
});

it("process death after atomic Git ref update recovers from SQLite rollback without a duplicate", async () => {
  const f = await fixture(),
    input = draft();
  const source = `const { KnowledgeStorage } = await import(${JSON.stringify(sourceModule("storage"))});
    let raw=''; for await(const c of process.stdin) raw+=c;
    const {config,input}=JSON.parse(raw);
    await new KnowledgeStorage(config,undefined,s=>{if(s==='after-git-ref') process.exit(77)}).save(input,{scope:{visibility:'private'},agentId:'main',assertCurrent(){}},'agent');`;
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, childEvalArgs(source), {
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("close", resolve);
    child.stdin.end(JSON.stringify({ config: f.config, input }));
  });
  expect(code).toBe(77);
  expect(f.service.resume(f.access, input.requestId).git!.state).toBe("committed");
  expect(git(f.root, "rev-list", "--count", "HEAD")).toBe("1");
  expect(git(f.root, "diff", "--cached", "--name-only")).toBe("");
});

it("external edits are one observed batch; rename and deletion keep per-file history", async () => {
  const f = await fixture(),
    a = await f.service.save(draft(), f.access, "agent"),
    b = await f.service.save(draft(), f.access, "agent");
  for (const r of [a, b]) {
    const p = path.join(f.root, "private", r.path);
    await writeFile(p, (await readFile(p, "utf8")).replace("First bytes.", "External bytes."));
  }
  await f.read(a.id);
  expect(git(f.root, "rev-list", "--count", "HEAD")).toBe("3");
  expect(
    git(f.root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n").length,
  ).toBe(2);
  await rename(
    path.join(f.root, "private", a.path),
    path.join(f.root, "private", a.path + "-renamed.md"),
  );
  await rm(path.join(f.root, "private", b.path));
  await f.read(a.id);
  expect(git(f.root, "rev-list", "--count", "HEAD")).toBe("4");
  expect(git(f.root, "ls-tree", "-r", "--name-only", "HEAD")).toBe(`private/${a.path}-renamed.md`);
  expect(
    git(f.root, "log", "--follow", "--format=%s", "--", `private/${a.path}-renamed.md`).split("\n")
      .length,
  ).toBe(3);
});

it("scope isolation: shared reads checkpoint neither private files nor private pending jobs", async () => {
  const f = await fixture();
  const offline = new KnowledgeStorage(
    f.config,
    f.store,
    undefined,
    new GitHistory(f.root, path.join(f.base, "missing-git")),
  );
  const secret = await offline.save(draft(), f.access, "agent");
  const shared = plainAccess({ visibility: "conversation", sessionId: randomUUID() });
  const receipt = await f.service.save(draft(), shared, "agent");
  expect(receipt.git!.state).toBe("committed");
  expect(git(f.root, "ls-tree", "-r", "--name-only", "HEAD")).not.toMatch(/private/);
  expect(f.service.history(shared, {}).git.pending).toBe(0);
  expect(f.service.history(f.access, {}).mutations[0]!.git!.state).toBe("unavailable");
  expect(f.service.resume(f.access, secret.requestId).git!.state).toBe("committed");
});

it("read-only stores never initialize Git; parent repositories are not adopted", async () => {
  const f = await fixture();
  await new KnowledgeStorage({ ...f.config, writesEnabled: false }).run(f.access, (v) => v.scan());
  expect(existsSync(path.join(f.root, ".git"))).toBe(false);
  git(f.base, "init", "--quiet");
  const saved = await f.service.save(draft(), f.access, "agent");
  expect(saved.git!.state).toBe("committed");
  expect(git(f.root, "rev-parse", "--show-toplevel")).toBe(realpathSync(f.root));
  expect(git(f.base, "ls-files")).toBe("");
});

it("repository lock and detached HEAD report history gaps without rejecting published writes", async () => {
  const f = await fixture(),
    first = await f.service.save(draft(), f.access, "agent");
  const record = await f.read(first.id);
  git(f.root, "checkout", "--detach", "--quiet");
  const input = edit(record),
    saved = await f.service.save(input, f.access, "agent");
  expect(saved.state).toBe("published");
  expect(saved.git!.state).toBe("pending");
  git(f.root, "checkout", "--quiet", "main");
  await writeFile(path.join(f.root, ".git", "index.lock"), "someone else");
  expect(f.service.resume(f.access, input.requestId).git!.state).toBe("pending");
  expect(await readFile(path.join(f.root, ".git", "index.lock"), "utf8")).toBe("someone else");
  await rm(path.join(f.root, ".git", "index.lock"));
  expect(f.service.resume(f.access, input.requestId).git!.state).toBe("committed");
  expect(git(f.root, "rev-list", "--count", "HEAD")).toBe("2");
});

it("Git uses exact publication bytes despite a subsequent editor write and never invokes hooks", async () => {
  const f = await fixture(),
    first = await f.service.save(draft(), f.access, "agent");
  const record = await f.read(first.id),
    marker = path.join(f.base, "hook-ran");
  await mkdir(path.join(f.root, ".git", "hooks"), { recursive: true });
  await writeFile(
    path.join(f.root, ".git", "hooks", "reference-transaction"),
    `#!/bin/sh\ntouch '${marker}'\n`,
    { mode: 0o755 },
  );
  const { writeFileSync } = await import("node:fs");
  const service = new KnowledgeStorage(f.config, f.store, (stage) => {
    if (stage === "before-git-ref") {
      writeFileSync(
        path.join(f.root, "private", first.path),
        record!.raw.replace("First bytes.", "Later external write."),
      );
    }
  });
  const saved = await service.save(edit(record), f.access, "agent");
  expect(saved.git!.state).toBe("committed");
  expect(git(f.root, "show", `HEAD:private/${first.path}`)).toMatch(/Second bytes/);
  expect(await readFile(path.join(f.root, "private", first.path), "utf8")).toMatch(
    /Later external write/,
  );
  expect(existsSync(marker)).toBe(false);
  await f.read(first.id);
  expect(git(f.root, "show", `HEAD:private/${first.path}`)).toMatch(/Later external write/);
});

it("unsafe Git directory is a visible nonfatal checkpoint failure and is never followed", async () => {
  const f = await fixture(),
    outside = path.join(f.base, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(f.root, ".git"));
  const saved = await f.service.save(draft(), f.access, "agent");
  expect(saved.state).toBe("published");
  expect(saved.git!.state).toBe("pending");
  expect(existsSync(path.join(outside, "HEAD"))).toBe(false);
});

it("read-side Git observes safe malformed Markdown and ontology without following unsafe files", async () => {
  const f = await fixture();
  await writeFile(path.join(f.root, "private", "broken.md"), "No record envelope\n");
  await writeFile(path.join(f.root, "private", ".extra.md"), "Hidden note\n");
  await writeFile(path.join(f.root, "private", "ontology.yaml"), "broken: [yaml\n");
  await symlink(path.join(f.root, "vault.json"), path.join(f.root, "private", "unsafe.md"));
  const result = await f.service.run(f.access, (v) => v.scan());
  expect(result.issues.length).toBeTruthy();
  expect(git(f.root, "ls-tree", "-r", "--name-only", "HEAD").split("\n")).toStrictEqual([
    "private/.extra.md",
    "private/broken.md",
    "private/ontology.yaml",
  ]);
  expect(f.service.history(f.access, {}).git.state).toBe("committed");
});

it("observation re-resolves source descriptors when an external edit adds a record citation", async () => {
  const { describeSource } = await import("./source-descriptors.js");
  const f = await fixture(),
    saved = await f.service.save(
      { ...draft(), source: { text: "Evidence bytes\n", attribution: "Source" } },
      f.access,
      "agent",
    );
  // Settle every stamp so observation caches this record's dependencies.
  const clock = vi.spyOn(Date, "now").mockImplementation(() => 4102444800000);
  afterTest(() => clock.mockRestore());
  const { source: first, ...origin } = (await f.read(saved.id))!.metadata.evidence![0]!;
  await f.read(saved.id);
  const second = describeSource({ ...origin, attribution: "Second origin" });
  expect(second.id).not.toBe(first);
  await writeFile(path.join(f.root, "private", second.path), second.raw);
  const file = path.join(f.root, "private", saved.path),
    raw = await readFile(file, "utf8");
  // Add a citation and keep the first, so every cached descriptor stamp still matches.
  expect(raw.includes(`  - source: ${first}\n`)).toBeTruthy();
  await writeFile(
    file,
    raw.replace(`  - source: ${first}\n`, `  - source: ${second.id}\n  - source: ${first}\n`),
  );
  expect((await f.read(saved.id))!.metadata.evidence!.map((e: any) => e.attribution)).toStrictEqual(
    ["Second origin", "Source"],
  );
  expect(
    git(f.root, "ls-tree", "-r", "--name-only", "HEAD")
      .split("\n")
      .includes(`private/${second.path}`),
    "new dependency observed despite the warm cache",
  ).toBeTruthy();
});
