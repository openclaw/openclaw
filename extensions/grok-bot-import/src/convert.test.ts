import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspaceSync,
  type TempWorkspaceSync,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGrokBotAvatarDefaults } from "./avatar.js";
import { convertGrokBotRecipe } from "./convert.js";
import { parseGrokBotRecipe } from "./recipe.js";
const workspaces: TempWorkspaceSync[] = [];
const tempDirs = {
  make(prefix: string) {
    const workspace = tempWorkspaceSync({ rootDir: resolvePreferredOpenClawTmpDir(), prefix });
    workspaces.push(workspace);
    return workspace.dir;
  },
};
afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    workspace.cleanup();
  }
});
function recipeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    profile: {
      name: "Research Buddy",
      description: "Research public sources. Never contact anyone.",
    },
    memory: [],
    skills: [],
    routines: [],
    plugins: [],
    ...overrides,
  });
}

describe("Grok Bot recipe conversion", () => {
  it("resolves missing hosted avatars from the source bot identity", () => {
    // Expected values from Grok Bot 0.18.0's pure u4e/sle functions.
    expect(resolveGrokBotAvatarDefaults({ id: "bot-a", avatarShape: "", avatarColor: "" })).toEqual(
      { avatarShape: "tablet", avatarColor: "orange" },
    );
    expect(resolveGrokBotAvatarDefaults({ id: "bot-b" })).toEqual({
      avatarShape: "blob",
      avatarColor: "blue",
    });
    expect(resolveGrokBotAvatarDefaults({ id: "🦀" })).toEqual({
      avatarShape: "blob",
      avatarColor: "green",
    });
    expect(
      resolveGrokBotAvatarDefaults({ id: "bot-a", avatarShape: "hex", avatarColor: "violet" }),
    ).toEqual({ avatarShape: "hex", avatarColor: "violet" });
    expect(
      resolveGrokBotAvatarDefaults({
        id: "bot-a",
        avatarShape: "future-shape",
        avatarColor: "#123456",
      }),
    ).toEqual({ avatarShape: "future-shape", avatarColor: "#123456" });
  });

  it("never overwrites existing files or follows a destination symlink", async () => {
    const root = tempDirs.make("grok-existing-");
    const destination = join(root, "claw");
    await mkdir(destination);
    await writeFile(join(destination, "keep.txt"), "Keep this.");
    const recipe = parseGrokBotRecipe(recipeJson());
    await expect(convertGrokBotRecipe({ recipe, destination })).rejects.toThrow(/new or empty/);
    expect(await readFile(join(destination, "keep.txt"), "utf8")).toBe("Keep this.");
    const empty = join(root, "empty");
    await mkdir(empty);
    const link = join(root, "link");
    await symlink(empty, link, "dir");
    await expect(convertGrokBotRecipe({ recipe, destination: link })).rejects.toThrow(/symlink/);
    expect(await readdir(empty)).toEqual([]);
  });

  it("rejects recipes that exceed native Claw file limits before publishing any output", async () => {
    const root = tempDirs.make("grok-large-");
    const destination = join(root, "claw");
    const recipe = parseGrokBotRecipe(
      recipeJson({
        skills: [
          { name: "Large skill", description: "Large skill.", content: "x".repeat(1024 * 1024) },
        ],
      }),
    );
    await expect(convertGrokBotRecipe({ recipe, destination })).rejects.toThrow(/1 MiB/);
    expect(await readdir(root)).toEqual([]);
  });

  it("reports a missing getting-started skill instead of inventing its contents", async () => {
    const destination = join(tempDirs.make("grok-missing-setup-"), "claw");
    const result = await convertGrokBotRecipe({
      recipe: parseGrokBotRecipe(recipeJson({ gettingStarted: { skill: "absent" } })),
      destination,
    });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "getting_started_skill_missing" }),
    );
    expect(await readFile(join(destination, "BOOTSTRAP.md"), "utf8")).not.toContain(
      "skills/absent",
    );
  });

  it("rejects invalid encoding, oversized input, and incomplete recipe schemas", () => {
    expect(() => parseGrokBotRecipe(Uint8Array.from([0xff]))).toThrow(/UTF-8 JSON/);
    expect(() => parseGrokBotRecipe(new Uint8Array(25 * 1024 * 1024 + 1))).toThrow(/25 MiB/);
    expect(() => parseGrokBotRecipe(recipeJson({ skills: [{ name: "Missing body" }] }))).toThrow(
      /skills\[0\].description/,
    );
    expect(() =>
      parseGrokBotRecipe(JSON.stringify({ name: "Marketplace preview", skills: [] })),
    ).toThrow(/profile/);
  });

  it("imports canonical desktop avatar shapes and named colors without substituting placeholders", async () => {
    const root = tempDirs.make("grok-shapes-");
    for (const shape of [
      "blob",
      "pebble",
      "bean",
      "egg",
      "squircle",
      "tablet",
      "capsule",
      "cylinder",
      "gem",
      "crystal",
      "wedge",
      "shield",
      "dome",
      "arch",
      "cloud",
      "teardrop",
      "leaf",
    ]) {
      const destination = join(root, shape);
      const result = await convertGrokBotRecipe({
        recipe: parseGrokBotRecipe(
          recipeJson({
            profile: {
              name: "Blue bot",
              description: "Research.",
              avatarShape: shape,
              avatarColor: "blue",
            },
          }),
        ),
        destination,
      });
      expect(result.warnings, shape).toEqual([]);
      const svg = await readFile(join(destination, "workspace/assets/grok-bot-avatar.svg"), "utf8");
      expect(svg).toContain("#1084FE");
      expect(svg).toContain('fill-rule="evenodd"');
      expect(svg).not.toContain("<circle");
    }
  });
});
