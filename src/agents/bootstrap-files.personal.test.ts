import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { linkEmail } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveBootstrapContextForRun } from "./bootstrap-files.js";
import * as workspaceFiles from "./workspace-file-read.js";
import { loadPersonalUserBootstrapFile } from "./workspace-personal-bootstrap.js";

vi.mock("../plugins/memory-runtime.js", () => ({
  classifyActiveMemoryWorkspacePaths: vi.fn(async () => ({ status: "unavailable" })),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let workspaceDir: string;
let alice: string;
const profile = (name: string) => ensureProfileForEmail(`${name}@example.test`).id;
const userPath = (id?: string) => path.join(workspaceDir, ...(id ? ["users", id] : []), "USER.md");
async function writeUser(content: string, id?: string) {
  await fs.mkdir(path.dirname(userPath(id)), { recursive: true });
  await fs.writeFile(userPath(id), content);
}
function load(
  id?: string,
  options: Partial<Parameters<typeof resolveBootstrapContextForRun>[0]> = {},
) {
  const params = { workspaceDir, bootstrapUserProfileId: id, ...options };
  return resolveBootstrapContextForRun(params).then(({ contextFiles }) => contextFiles);
}
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "personal-" });
  workspaceDir = path.join(tempDirs.make("bootstrap-people-"), "users", "arbitrary");
  alice = profile("alice");
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await state.cleanup();
});

it("rejects a retired profile's overlay after a merge during the file read", async () => {
  const bob = profile("bob");
  profile("third");
  await writeUser("Alice private preferences", alice);
  const read = workspaceFiles.readWorkspaceFileWithGuards;
  const intercepted = vi
    .spyOn(workspaceFiles, "readWorkspaceFileWithGuards")
    .mockImplementationOnce(async (params) => {
      const loaded = await read(params);
      linkEmail("alice@example.test", bob);
      return loaded;
    });
  try {
    expect(await loadPersonalUserBootstrapFile(workspaceDir, alice)).toBeUndefined();
    expect(intercepted).toHaveBeenCalledOnce();
  } finally {
    intercepted.mockRestore();
  }
});

it("refreshes the selected overlay without retaining a previous selection", async () => {
  const bob = profile("bob");
  await writeUser("Shared defaults");
  await writeUser("Alice preferences", alice);
  await writeUser("Bob preferences", bob);
  expect((await loadPersonalUserBootstrapFile(workspaceDir, alice))?.origin).toEqual({
    kind: "personal",
    rootPath: path.dirname(userPath(alice)),
  });
  const users = async (id?: string) =>
    (await load(id, { sessionKey: "agent:main:shared" })).filter((file) =>
      file.path.endsWith("USER.md"),
    );
  const contents = async (id?: string) => (await users(id)).map((file) => file.content);
  expect(await users(alice)).toEqual([
    { path: userPath(), content: "Shared defaults" },
    { path: userPath(alice), content: "Alice preferences", personalUser: true },
  ]);
  expect(await contents(bob)).toEqual(["Shared defaults", "Bob preferences"]);
  for (const id of [undefined, "unknown", "../" + alice]) {
    expect(await contents(id)).toEqual(["Shared defaults"]);
  }
  await writeUser("Updated Alice preferences", alice);
  expect((await users(alice)).at(-1)?.content).toBe("Updated Alice preferences");
  profile("third");
  linkEmail("alice@example.test", bob);
  expect(await contents(alice)).toEqual(["Shared defaults", "Bob preferences"]);
  await fs.unlink(userPath(bob));
  expect(await contents(bob)).toEqual(["Shared defaults"]);
});

it("retains the shared USER budget when the workspace resembles a personal directory", async () => {
  await writeUser("Shared preferences. ".repeat(300));
  const warn = vi.fn();
  const users = (await load(alice, { warn })).filter((file) => file.path.endsWith("USER.md"));
  expect(users).toHaveLength(1);
  expect(users[0]?.content).toContain("Shared preferences.");
  expect(users[0]?.content).toContain("read USER.md for full content");
  expect(users[0]?.personalUser).toBeUndefined();
  expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("Personal USER.md"));
});

it.each(["file", "parent", "hardlink"] as const)(
  "rejects cross-profile %s aliases",
  async (alias) => {
    const bob = profile("bob");
    await writeUser("Bob preferences", bob);
    const aliceDir = path.dirname(userPath(alice));
    if (alias === "parent") {
      await fs.symlink(path.dirname(userPath(bob)), aliceDir, "junction");
    } else {
      await fs.mkdir(aliceDir);
      await (alias === "hardlink" ? fs.link : fs.symlink)(userPath(bob), userPath(alice));
    }
    expect((await load(alice)).some((file) => file.content.includes("Bob preferences"))).toBe(
      false,
    );
  },
);

it.each([
  ["budget", "personal".repeat(600)],
  ["read-budget", "personal".repeat(300_000)],
  ["subagent", "personal preferences"],
])("preserves the %s boundary for personal instructions", async (boundary, content) => {
  profile("bob");
  await writeUser(content, alice);
  const files = await load(alice, {
    sessionKey: boundary === "subagent" ? "agent:main:subagent:child" : "agent:main:shared",
  });
  expect(files.some((file) => file.content.includes("personal"))).toBe(false);
});
