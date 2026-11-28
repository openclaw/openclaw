import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoreCodingTools } from "../../core-coding-tools.js";
import {
  resolveOwnSpillFile,
  openPrivateTempFileStream,
  writePrivateTempFile,
} from "./private-temp-file.js";

const cleanupPaths: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    cleanupPaths.splice(0).map((file) => rm(file, { recursive: true, force: true })),
  );
});

function freshOwner() {
  return { agentId: "spill-test", sessionKey: randomUUID() };
}

async function workspaceTools(spillOwner = freshOwner()) {
  const root = await mkdtemp(path.join(tmpdir(), "spill-workspace-"));
  cleanupPaths.push(root);
  return createCoreCodingTools({
    codingRoot: root,
    containmentRoot: root,
    includeBaseCodingTools: true,
    shellTools: "patch-only",
    workspaceOnly: true,
    readOnly: false,
    applyPatchEnabled: true,
    applyPatchWorkspaceOnly: true,
    execDefaults: {},
    processDefaults: {},
    spillOwner,
  });
}

async function spill(owner = freshOwner()) {
  const file = await writePrivateTempFile(
    "openclaw-tool-result",
    "first\nsecond\nthird\nfourth\n",
    { owner },
  );
  cleanupPaths.push(file);
  return file;
}

describe("session-owned spill reads", () => {
  it("reads its own spill outside the workspace with offset and limit", async () => {
    const owner = freshOwner();
    const tools = await workspaceTools(owner);
    const file = await spill(owner);
    const result = await tools
      .find((tool) => tool.name === "read")!
      .execute("read-spill", {
        path: file,
        offset: 2,
        limit: 2,
      });
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringMatching(/second[\s\S]*third/u) }),
    ]);
    expect(JSON.stringify(result.content)).not.toContain("first");
    expect(JSON.stringify(result.content)).not.toContain("fourth");
  });

  it.each([
    "plugin path",
    "unissued spill-like name",
    "another session",
    "another agent",
    "fresh owner",
  ])("denies %s", async (scenario) => {
    const owner = freshOwner();
    const tools = await workspaceTools(owner);
    let file: string;
    if (scenario === "plugin path" || scenario === "unissued spill-like name") {
      const prefix = scenario === "plugin path" ? "plugin" : "openclaw-tool-result";
      file = path.join(tmpdir(), `${prefix}-${randomUUID()}.log`);
      await writeFile(file, "not issued by the private writer");
      cleanupPaths.push(file);
    } else {
      const other =
        scenario === "another agent"
          ? { ...owner, agentId: "another-agent" }
          : scenario === "fresh owner"
            ? { agentId: "fresh-agent", sessionKey: randomUUID() }
            : { ...owner, sessionKey: randomUUID() };
      file = await spill(other);
    }
    await expect(
      tools.find((tool) => tool.name === "read")!.execute("denied", { path: file }),
    ).rejects.toThrow(/(root|workspace)/iu);
  });

  it("denies a registered path replaced by a symlink or directory", async () => {
    const owner = freshOwner();
    const read = (await workspaceTools(owner)).find((tool) => tool.name === "read")!;
    const file = await spill(owner);
    const neighbour = await spill();
    await rm(file);
    await symlink(neighbour, file);
    await expect(read.execute("symlink", { path: file })).rejects.toThrow(/(root|workspace)/iu);
    await rm(file);
    await mkdir(file);
    await expect(read.execute("directory", { path: file })).rejects.toThrow(/(root|workspace)/iu);
  });

  it("allows aliases of exactly the issued file, not its neighbour", async () => {
    if (process.platform === "darwin") {
      const aliasRoot = await mkdtemp("/var/tmp/openclaw-spill-alias-");
      cleanupPaths.push(aliasRoot);
      vi.stubEnv("TMPDIR", aliasRoot);
    }
    const owner = freshOwner();
    const read = (await workspaceTools(owner)).find((tool) => tool.name === "read")!;
    const file = await spill(owner);
    const neighbour = await spill();
    const alias = (value: string) =>
      `${path.dirname(value)}/../${path.basename(path.dirname(value))}/${path.basename(value)}`;
    const cases = [[alias(file), alias(neighbour)]];
    if (process.platform === "darwin" && file.startsWith("/var/")) {
      cases.push([`/private${file}`, `/private${neighbour}`]);
    } else if (process.platform === "darwin" && file.startsWith("/private/var/")) {
      cases.push([file.slice("/private".length), neighbour.slice("/private".length)]);
    }
    for (const [allowed, denied] of cases) {
      const result = await read.execute("alias", { path: allowed, offset: 2, limit: 1 });
      expect(JSON.stringify(result.content)).toContain("second");
      await expect(read.execute("neighbour", { path: denied })).rejects.toThrow(
        /(root|workspace)/iu,
      );
    }
  });

  it("does not grant mutations, directory listing, or apply_patch", async () => {
    const owner = freshOwner();
    const tools = await workspaceTools(owner);
    const file = await spill(owner);
    for (const [name, args] of [
      ["write", { path: file, content: "changed" }],
      ["edit", { path: file, oldText: "first", newText: "changed" }],
      ["ls", { path: file }],
      [
        "apply_patch",
        {
          input: `*** Begin Patch\n*** Update File: ${file}\n@@\n-first\n+changed\n*** End Patch`,
        },
      ],
    ] as const) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, name).toBeDefined();
      await expect(tool!.execute(name, args)).rejects.toThrow(/(root|workspace)/iu);
    }
    expect(await readFile(file, "utf8")).toBe("first\nsecond\nthird\nfourth\n");
  });

  it("admits a successfully created stream only to its owner", async () => {
    const owner = freshOwner();
    const output = openPrivateTempFileStream("openclaw-exec", 1024, { owner });
    cleanupPaths.push(output.path);
    output.write("streamed content\n");
    expect(await output.close()).toBe(true);
    const read = (await workspaceTools(owner)).find((tool) => tool.name === "read")!;
    expect(JSON.stringify((await read.execute("stream", { path: output.path })).content)).toContain(
      "streamed content",
    );
    expect(await resolveOwnSpillFile(freshOwner(), output.path)).toBeUndefined();
  });

  it("fails closed for missing files and files with another uid", async () => {
    const owner = freshOwner();
    const file = await spill(owner);
    if (typeof process.getuid === "function") {
      const uid = process.getuid();
      vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
      expect(await resolveOwnSpillFile(owner, file)).toBeUndefined();
      vi.restoreAllMocks();
    }
    await rm(file);
    expect(await resolveOwnSpillFile(owner, file)).toBeUndefined();
  });

  it("forgets all but the newest 64 paths and 256 most recently registered owners", async () => {
    const owner = freshOwner();
    const first = await spill(owner);
    for (let i = 0; i < 63; i++) {
      await spill(owner);
    }
    expect(await resolveOwnSpillFile(owner, first)).toBe(await realpath(first));
    const newest = await spill(owner);
    expect(await resolveOwnSpillFile(owner, first)).toBeUndefined();
    expect(await resolveOwnSpillFile(owner, newest)).toBe(await realpath(newest));
    const refreshedOwner = freshOwner();
    await spill(refreshedOwner);
    for (let i = 0; i < 254; i++) {
      await spill();
    }
    expect(await resolveOwnSpillFile(owner, newest)).toBe(await realpath(newest));
    const refreshedFile = await spill(refreshedOwner);
    await spill();
    expect(await resolveOwnSpillFile(owner, newest)).toBeUndefined();
    expect(await resolveOwnSpillFile(refreshedOwner, refreshedFile)).toBe(
      await realpath(refreshedFile),
    );
  });
});
