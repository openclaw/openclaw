import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail, linkEmail } from "../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveBootstrapContextForRun } from "./bootstrap-files.js";
const memoryRuntimeMocks = vi.hoisted(() => ({ classifyWorkspacePaths: vi.fn() }));
vi.mock("../plugins/memory-runtime.js", () => ({
  classifyActiveMemoryWorkspacePaths: (...args: unknown[]) =>
    memoryRuntimeMocks.classifyWorkspacePaths(...args),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "bootstrap-people-state-",
  });
  memoryRuntimeMocks.classifyWorkspacePaths
    .mockReset()
    .mockResolvedValue({ status: "unavailable" });
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await state.cleanup();
});
describe("personal bootstrap", () => {
  it("refreshes personal overlays without leaking between people in a shared session", async () => {
    const workspaceDir = tempDirs.make("bootstrap-people-");
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
    expect((await load(alice.id)).map((file) => file.content)).toEqual([
      "Shared defaults",
      "Alice preferences",
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
    linkEmail("alice@example.test", bob.id);
    expect((await load(alice.id)).map((file) => file.content)).toEqual([
      "Shared defaults",
      "Bob preferences",
    ]);
    await fs.unlink(path.join(workspaceDir, "users", bob.id, "USER.md"));
    expect((await load(bob.id)).map((file) => file.content)).toEqual(["Shared defaults"]);
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

  it.each(["budget", "read-budget", "provenance", "subagent", "lightweight"] as const)(
    "preserves the %s boundary for personal instructions",
    async (boundary) => {
      const workspaceDir = tempDirs.make("bootstrap-people-boundary-");
      const alice = ensureProfileForEmail("alice@example.test");
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
      memoryRuntimeMocks.classifyWorkspacePaths.mockResolvedValue({
        status: "classified",
        classifications: [
          { relativePath: "users/" + alice.id + "/USER.md", originClass: "untrusted" },
        ],
      });
      const context = await resolveBootstrapContextForRun({
        workspaceDir,
        bootstrapUserProfileId: alice.id,
        ...(boundary === "provenance" ? { config: {}, agentId: "main" } : {}),
        sessionKey: boundary === "subagent" ? "agent:main:subagent:child" : "agent:main:shared",
        contextMode: boundary === "lightweight" ? "lightweight" : "full",
      });
      expect(context.contextFiles.some((file) => file.content.includes("personal"))).toBe(false);
    },
  );
});
