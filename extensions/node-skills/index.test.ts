import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeSkillCommands } from "./index.js";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-skills-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "skills", "open-pr"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "skills", "open-pr", "SKILL.md"),
    [
      "---",
      "name: open-pr",
      "description: Open pull requests with browser context",
      "---",
      "Use browser.open separately after reading the PR URL.",
      "",
    ].join("\n"),
  );
  return dir;
}

function fakeApi(workspaceDir: string): OpenClawPluginApi {
  return {
    config: {},
    runtime: {
      agent: {
        resolveAgentWorkspaceDir: () => workspaceDir,
      },
    },
    registerNodeHostCommand: () => undefined,
  } as unknown as OpenClawPluginApi;
}

async function invoke(
  command: { handle(paramsJSON?: string | null): Promise<string> },
  params?: unknown,
) {
  const raw = await command.handle(params === undefined ? undefined : JSON.stringify(params));
  return JSON.parse(raw) as { details?: unknown };
}

function findOpenPrSkill(skills: Array<{ id: string; digest: string; name?: string }>) {
  const skill = skills.find((entry) => entry.name === "open-pr");
  expect(skill).toBeDefined();
  return skill!;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("node-skills node-host plugin", () => {
  it("publishes provider-safe node-hosted skill tools", async () => {
    const commands = createNodeSkillCommands(fakeApi(await makeWorkspace()));

    expect(commands.map((command) => command.command)).toEqual([
      "node-skills.list",
      "node-skills.read",
    ]);
    expect(commands.map((command) => command.agentTool.name)).toEqual([
      "node_skills_list",
      "node_skills_read",
    ]);
    expect(commands.every((command) => command.agentTool.defaultPlatforms?.includes("macos"))).toBe(
      true,
    );
  });

  it("lists and reads bounded skill text by digest", async () => {
    const commands = createNodeSkillCommands(fakeApi(await makeWorkspace()));
    const list = (await invoke(commands[0])) as {
      details: { skills: Array<{ id: string; digest: string }> };
    };
    const skill = findOpenPrSkill(list.details.skills);

    const read = (await invoke(commands[1], {
      id: skill.id,
      digest: skill.digest,
      maxBytes: 16,
    })) as {
      details: { skill: { text: string }; _note: string };
    };

    expect(read.details.skill.text.length).toBeLessThanOrEqual(16);
    expect(read.details._note).toContain("user-authored content");
  });

  it("fails closed on stale digest", async () => {
    const commands = createNodeSkillCommands(fakeApi(await makeWorkspace()));
    const list = (await invoke(commands[0])) as {
      details: { skills: Array<{ id: string; digest: string }> };
    };

    const stale = (await invoke(commands[1], {
      id: findOpenPrSkill(list.details.skills).id,
      digest: "sha256:stale",
    })) as { details: { ok: boolean; code: string } };

    expect(stale.details).toMatchObject({ ok: false, code: "stale-digest" });
  });
});
