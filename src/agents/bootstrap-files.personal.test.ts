import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  registerInternalHook,
  unregisterInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { linkEmail } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveBootstrapContextForRun } from "./bootstrap-files.js";
import * as workspaceFiles from "./workspace-file-read.js";
import { loadPersonalUserBootstrapFile } from "./workspace-personal-bootstrap.js";
vi.mock("../plugins/memory-runtime.js", () => ({
  classifyActiveMemoryWorkspacePaths: vi.fn(async () => ({ status: "unavailable" })),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "bootstrap-people-state-",
  });
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await state.cleanup();
});
describe("personal bootstrap", () => {
  it("keeps shared defaults but does not open selected profiles in non-private sessions", async () => {
    const workspaceDir = tempDirs.make("bootstrap-people-audience-");
    const alice = ensureProfileForEmail("alice@example.test");
    const bob = ensureProfileForEmail("bob@example.test");
    await fs.writeFile(path.join(workspaceDir, "USER.md"), "Shared defaults");
    for (const [id, content] of [
      [alice.id, "Alice private preferences"],
      [bob.id, "Bob private preferences"],
    ] as const) {
      const dir = path.join(workspaceDir, "users", id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "USER.md"), content);
    }
    const load = async (sessionKey: string, chatType?: "direct" | "group" | "channel") => {
      const context = await resolveBootstrapContextForRun({
        workspaceDir,
        bootstrapUserProfileId: alice.id,
        sessionKey,
        chatType,
      });
      return context.contextFiles.filter((file) => file.path.endsWith("USER.md"));
    };
    expect((await load("agent:main:private", "direct")).map((file) => file.content)).toEqual([
      "Shared defaults",
      "Alice private preferences",
    ]);
    using reads = vi.spyOn(workspaceFiles, "readWorkspaceFileWithGuards");
    for (const [key, chatType, expected] of [
      ["agent:main:opaque", "group", ["Shared defaults"]],
      ["agent:main:opaque", "channel", ["Shared defaults"]],
      ["agent:main:discord:group:room", undefined, ["Shared defaults"]],
      ["agent:main:discord:channel:room", undefined, ["Shared defaults"]],
      ["agent:main:cron:daily", undefined, ["Shared defaults"]],
      ["agent:main:subagent:child", undefined, []],
    ] as const) {
      reads.mockClear();
      const files = await load(key, chatType);
      expect(
        files.map((file) => file.content),
        key,
      ).toEqual(expected);
      expect(
        reads.mock.calls.some(([params]) =>
          params.filePath.includes(`${path.sep}users${path.sep}`),
        ),
        key,
      ).toBe(false);
    }
    expect((await load("agent:main:private", "direct")).map((file) => file.content)).toEqual([
      "Shared defaults",
      "Alice private preferences",
    ]);
    expect(
      (await load("agent:main:discord:group:room", "direct")).map((file) => file.content),
    ).toEqual(["Shared defaults", "Alice private preferences"]);
  });

  it.each(["group", "channel"] as const)(
    "withholds personal sources added by bootstrap hooks in a %s",
    async (chatType) => {
      const workspaceDir = tempDirs.make("bootstrap-people-hook-audience-");
      await fs.writeFile(path.join(workspaceDir, "USER.md"), "Shared defaults");
      const personalDir = path.join(workspaceDir, "users", "synthetic");
      const hook: Parameters<typeof registerInternalHook>[1] = (event) => {
        const context = event.context as AgentBootstrapHookContext;
        context.bootstrapFiles.push(
          {
            name: "USER.md",
            path: path.join(personalDir, "USER.md"),
            content: "Hook private preferences",
            missing: false,
            personalUser: true,
          },
          {
            name: "USER.md",
            path: path.join(personalDir, "other", "USER.md"),
            content: "Origin private preferences",
            missing: false,
            origin: { kind: "personal", rootPath: personalDir },
          },
        );
      };
      registerInternalHook("agent:bootstrap", hook);
      try {
        const context = await resolveBootstrapContextForRun({
          workspaceDir,
          sessionKey: "agent:main:opaque",
          chatType,
        });
        expect(context.contextFiles.filter((file) => file.path.endsWith("USER.md"))).toEqual([
          { path: path.join(workspaceDir, "USER.md"), content: "Shared defaults" },
        ]);
      } finally {
        unregisterInternalHook("agent:bootstrap", hook);
      }
    },
  );

  it("rejects a retired profile's overlay after worker preparation and a merge during the file read", async () => {
    const workspaceDir = tempDirs.make("bootstrap-profile-retired-");
    const alice = ensureProfileForEmail("alice@example.test");
    const bob = ensureProfileForEmail("bob@example.test");
    ensureProfileForEmail("third@example.test");
    const personalDir = path.join(workspaceDir, "users", alice.id);
    await fs.mkdir(personalDir, { recursive: true });
    await fs.writeFile(path.join(personalDir, "USER.md"), "Alice private preferences");
    const read = workspaceFiles.readWorkspaceFileWithGuards;
    using intercepted = vi
      .spyOn(workspaceFiles, "readWorkspaceFileWithGuards")
      .mockImplementationOnce(async (params) => {
        const loaded = await read(params);
        linkEmail("alice@example.test", bob.id);
        return loaded;
      });

    expect(await loadPersonalUserBootstrapFile(workspaceDir, alice.id)).toBeUndefined();
    expect(intercepted).toHaveBeenCalledOnce();
  });

  it("refreshes the selected overlay without retaining a previous selection", async () => {
    const workspaceDir = path.join(tempDirs.make("bootstrap-people-"), "users", "arbitrary");
    await fs.mkdir(workspaceDir, { recursive: true });
    const alice = ensureProfileForEmail("alice@example.test");
    const bob = ensureProfileForEmail("bob@example.test");
    const writePersonal = async (id: string, content: string) => {
      const dir = path.join(workspaceDir, "users", id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "USER.md"), content);
    };
    await fs.writeFile(path.join(workspaceDir, "USER.md"), "Shared defaults");
    await writePersonal(alice.id, "Alice preferences");
    await writePersonal(bob.id, "Bob preferences");
    expect((await loadPersonalUserBootstrapFile(workspaceDir, alice.id))?.origin).toEqual({
      kind: "personal",
      rootPath: path.join(workspaceDir, "users", alice.id),
    });
    const load = async (bootstrapUserProfileId?: string) => {
      const context = await resolveBootstrapContextForRun({
        workspaceDir,
        sessionKey: "agent:main:shared",
        bootstrapUserProfileId,
      });
      return context.contextFiles.filter((file) => file.path.endsWith("USER.md"));
    };
    expect(await load(alice.id)).toEqual([
      { path: path.join(workspaceDir, "USER.md"), content: "Shared defaults" },
      {
        path: path.join(workspaceDir, "users", alice.id, "USER.md"),
        content: "Alice preferences",
        personalUser: true,
      },
    ]);
    expect((await load(bob.id)).map((file) => file.content)).toEqual([
      "Shared defaults",
      "Bob preferences",
    ]);
    expect((await load()).map((file) => file.content)).toEqual(["Shared defaults"]);
    expect((await load("unknown")).map((file) => file.content)).toEqual(["Shared defaults"]);
    expect((await load("../" + alice.id)).map((file) => file.content)).toEqual(["Shared defaults"]);
    await writePersonal(alice.id, "Updated Alice preferences");
    expect((await load(alice.id)).at(-1)?.content).toBe("Updated Alice preferences");
    ensureProfileForEmail("third@example.test");
    linkEmail("alice@example.test", bob.id);
    expect((await load(alice.id)).map((file) => file.content)).toEqual([
      "Shared defaults",
      "Bob preferences",
    ]);
    await fs.unlink(path.join(workspaceDir, "users", bob.id, "USER.md"));
    expect((await load(bob.id)).map((file) => file.content)).toEqual(["Shared defaults"]);
  });

  it("retains the shared USER budget when the workspace resembles a personal directory", async () => {
    const workspaceDir = path.join(tempDirs.make("bootstrap-solo-"), "users", "arbitrary");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "USER.md"), "Shared preferences. ".repeat(300));
    const alice = ensureProfileForEmail("alice@example.test");
    const warn = vi.fn();
    const context = await resolveBootstrapContextForRun({
      workspaceDir,
      bootstrapUserProfileId: alice.id,
      warn,
    });
    const users = context.contextFiles.filter((file) => file.path.endsWith("USER.md"));
    expect(users).toHaveLength(1);
    expect(users[0]?.content).toContain("Shared preferences.");
    expect(users[0]?.content).toContain("read USER.md for full content");
    expect(users[0]?.personalUser).toBeUndefined();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("Personal USER.md"));
  });

  it.each(["file", "parent", "hardlink"] as const)(
    "rejects a personal %s alias to another person's file",
    async (alias) => {
      const workspaceDir = tempDirs.make("bootstrap-people-alias-");
      const alice = ensureProfileForEmail("alice@example.test");
      const bob = ensureProfileForEmail("bob@example.test");
      const aliceDir = path.join(workspaceDir, "users", alice.id);
      const bobDir = path.join(workspaceDir, "users", bob.id);
      await fs.mkdir(bobDir, { recursive: true });
      await fs.writeFile(path.join(bobDir, "USER.md"), "Bob preferences");
      if (alias === "parent") {
        await fs.symlink(bobDir, aliceDir, "junction");
      } else {
        await fs.mkdir(aliceDir);
        if (alias === "hardlink") {
          await fs.link(path.join(bobDir, "USER.md"), path.join(aliceDir, "USER.md"));
        } else {
          await fs.symlink(path.join(bobDir, "USER.md"), path.join(aliceDir, "USER.md"));
        }
      }
      const context = await resolveBootstrapContextForRun({
        workspaceDir,
        bootstrapUserProfileId: alice.id,
      });
      expect(context.contextFiles.some((file) => file.content.includes("Bob preferences"))).toBe(
        false,
      );
    },
  );

  it.each(["budget", "read-budget", "subagent"] as const)(
    "preserves the %s boundary for personal instructions",
    async (boundary) => {
      const workspaceDir = tempDirs.make("bootstrap-people-boundary-");
      const alice = ensureProfileForEmail("alice@example.test");
      ensureProfileForEmail("bob@example.test");
      const personalDir = path.join(workspaceDir, "users", alice.id);
      await fs.mkdir(personalDir, { recursive: true });
      await fs.writeFile(
        path.join(personalDir, "USER.md"),
        boundary === "read-budget"
          ? "personal".repeat(300_000)
          : boundary === "budget"
            ? "personal".repeat(600)
            : "personal preferences",
      );
      const context = await resolveBootstrapContextForRun({
        workspaceDir,
        bootstrapUserProfileId: alice.id,
        sessionKey: boundary === "subagent" ? "agent:main:subagent:child" : "agent:main:shared",
      });
      expect(context.contextFiles.some((file) => file.content.includes("personal"))).toBe(false);
    },
  );
});
