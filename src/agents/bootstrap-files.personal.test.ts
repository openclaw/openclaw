import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  linkEmail,
} from "../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveBootstrapContextForRun } from "./bootstrap-files.js";
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
  it.each(["owner", "named"])(
    "keeps only workspace USER.md for a single %s identity",
    async (kind) => {
      const workspaceDir = tempDirs.make("bootstrap-single-user-");
      const owner = ensureGatewayOwnerProfile("Local Owner");
      const profile = kind === "owner" ? owner : ensureProfileForEmail("solo@example.test");
      const personalDir = path.join(workspaceDir, "users", profile.id);
      await fs.mkdir(personalDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "USER.md"), "Only workspace preferences");
      await fs.writeFile(path.join(personalDir, "USER.md"), "Legacy personal preferences");
      const context = await resolveBootstrapContextForRun({
        workspaceDir,
        bootstrapUserProfileId: profile.id,
      });
      expect(context.contextFiles.filter((file) => file.path.endsWith("USER.md"))).toEqual([
        { path: path.join(workspaceDir, "USER.md"), content: "Only workspace preferences" },
      ]);
      expect(await fs.readFile(path.join(personalDir, "USER.md"), "utf8")).toBe(
        "Legacy personal preferences",
      );
    },
  );

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
