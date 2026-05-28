import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverFeishuSkillSubscriberSources,
  loadFeishuSkillSubscriberSpecs,
  type FeishuSkillSubscriberSkillSource,
} from "./event.skill-loader.js";
import { FEISHU_SKILL_SUBSCRIBERS_FILENAME } from "./event.skill-spec.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeSkillFiles(params: {
  rootDir: string;
  relativeDir: string;
  skillName: string;
  subscriberSpec?: string;
}): Promise<FeishuSkillSubscriberSkillSource> {
  const skillBaseDir = path.join(params.rootDir, params.relativeDir);
  await fs.mkdir(skillBaseDir, { recursive: true });
  const skillFilePath = path.join(skillBaseDir, "SKILL.md");
  await fs.writeFile(
    skillFilePath,
    `---\nname: ${params.skillName}\ndescription: test skill\n---\n\n# ${params.skillName}\n`,
    "utf-8",
  );
  if (params.subscriberSpec !== undefined) {
    await fs.writeFile(
      path.join(skillBaseDir, FEISHU_SKILL_SUBSCRIBERS_FILENAME),
      params.subscriberSpec,
      "utf-8",
    );
  }
  return {
    skillName: params.skillName,
    skillFilePath,
    skillBaseDir,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("event.skill-loader", () => {
  it("discovers skill directories under skill roots", async () => {
    const rootDir = await createTempDir("openclaw-feishu-skill-loader-discover-");
    await writeSkillFiles({
      rootDir,
      relativeDir: "skills/group/approval-helper",
      skillName: "approval-helper",
    });

    const discovered = await discoverFeishuSkillSubscriberSources({
      skillRoots: [path.join(rootDir, "skills")],
    });

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      skillName: "approval-helper",
    });
  });

  it("loads valid specs, skips disabled subscribers, and reports duplicates", async () => {
    const rootDir = await createTempDir("openclaw-feishu-skill-loader-load-");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    };

    const firstSkill = await writeSkillFiles({
      rootDir,
      relativeDir: "skills/approval-helper",
      skillName: "approval-helper",
      subscriberSpec: JSON.stringify(
        {
          version: 1,
          subscribers: [
            {
              id: "approval-review",
              targetAgentId: "ops",
              trigger: {
                prompt: "handle approval event",
              },
            },
            {
              id: "disabled-subscriber",
              enabled: false,
              targetAgentId: "ops",
              trigger: {
                prompt: "disabled",
              },
            },
          ],
        },
        null,
        2,
      ),
    });
    const secondSkill = await writeSkillFiles({
      rootDir,
      relativeDir: "skills/approval-duplicate",
      skillName: "approval-duplicate",
      subscriberSpec: JSON.stringify(
        {
          version: 1,
          subscribers: [
            {
              id: "approval-review",
              targetAgentId: "ops-2",
              trigger: {
                prompt: "duplicate",
              },
            },
          ],
        },
        null,
        2,
      ),
    });

    const result = await loadFeishuSkillSubscriberSpecs({
      skillSources: [firstSkill, secondSkill],
      runtime,
    });

    expect(result.manifests).toHaveLength(2);
    expect(result.subscribers).toHaveLength(1);
    expect(result.subscribers[0]?.definition.id).toBe("approval-review");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          skillName: "approval-duplicate",
          message: expect.stringContaining('duplicate subscriber id "approval-review"'),
        }),
      ]),
    );
    expect(runtime.log).toHaveBeenCalled();
  });

  it("reports invalid sidecar files without failing other skills", async () => {
    const rootDir = await createTempDir("openclaw-feishu-skill-loader-invalid-");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    };

    const validSkill = await writeSkillFiles({
      rootDir,
      relativeDir: "skills/valid-skill",
      skillName: "valid-skill",
      subscriberSpec: JSON.stringify(
        {
          version: 1,
          subscribers: [
            {
              id: "valid-subscriber",
              targetAgentId: "ops",
              trigger: {
                prompt: "valid prompt",
              },
            },
          ],
        },
        null,
        2,
      ),
    });
    const invalidSkill = await writeSkillFiles({
      rootDir,
      relativeDir: "skills/invalid-skill",
      skillName: "invalid-skill",
      subscriberSpec: '{"version":1,"subscribers":[',
    });

    const result = await loadFeishuSkillSubscriberSpecs({
      skillSources: [validSkill, invalidSkill],
      runtime,
    });

    expect(result.manifests).toHaveLength(1);
    expect(result.subscribers).toHaveLength(1);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          skillName: "invalid-skill",
        }),
      ]),
    );
    expect(runtime.error).toHaveBeenCalled();
  });

  it("skips handler subscribers when the handler file is missing", async () => {
    const rootDir = await createTempDir("openclaw-feishu-skill-loader-handler-missing-");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    };

    const skill = await writeSkillFiles({
      rootDir,
      relativeDir: "skills/bitable-log",
      skillName: "bitable-log",
      subscriberSpec: JSON.stringify(
        {
          version: 1,
          subscribers: [
            {
              id: "bitable-record-log",
              handler: {
                file: "./missing.handler.mjs",
              },
            },
          ],
        },
        null,
        2,
      ),
    });

    const result = await loadFeishuSkillSubscriberSpecs({
      skillSources: [skill],
      runtime,
    });

    expect(result.manifests).toHaveLength(1);
    expect(result.subscribers).toHaveLength(0);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          skillName: "bitable-log",
          message: expect.stringContaining("subscriber handler file not found"),
        }),
      ]),
    );
  });

  it("rejects handler paths that escape the skill directory", async () => {
    const rootDir = await createTempDir("openclaw-feishu-skill-loader-handler-escape-");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    };

    const skill = await writeSkillFiles({
      rootDir,
      relativeDir: "skills/bitable-log",
      skillName: "bitable-log",
      subscriberSpec: JSON.stringify(
        {
          version: 1,
          subscribers: [
            {
              id: "bitable-record-log",
              handler: {
                file: "../escape.handler.mjs",
              },
            },
          ],
        },
        null,
        2,
      ),
    });

    const result = await loadFeishuSkillSubscriberSpecs({
      skillSources: [skill],
      runtime,
    });

    expect(result.manifests).toHaveLength(1);
    expect(result.subscribers).toHaveLength(0);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          skillName: "bitable-log",
          message: expect.stringContaining("escapes skill directory"),
        }),
      ]),
    );
  });

  it("logs each successfully loaded subscriber with skill name and handler status", async () => {
    const rootDir = await createTempDir("openclaw-feishu-skill-loader-success-log-");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    };

    const triggerSkill = await writeSkillFiles({
      rootDir,
      relativeDir: "skills/approval-helper",
      skillName: "approval-helper",
      subscriberSpec: JSON.stringify(
        {
          version: 1,
          subscribers: [
            {
              id: "approval-review",
              targetAgentId: "ops",
              trigger: {
                prompt: "handle approval event",
              },
            },
          ],
        },
        null,
        2,
      ),
    });
    const handlerSkill = await writeSkillFiles({
      rootDir,
      relativeDir: "skills/bitable-log",
      skillName: "bitable-log",
      subscriberSpec: JSON.stringify(
        {
          version: 1,
          subscribers: [
            {
              id: "bitable-record-log",
              handler: {
                file: "./bitable-record-log.handler.mjs",
              },
            },
          ],
        },
        null,
        2,
      ),
    });
    await fs.writeFile(
      path.join(handlerSkill.skillBaseDir, "bitable-record-log.handler.mjs"),
      "export async function handleFeishuEvent() {}\n",
      "utf-8",
    );

    await loadFeishuSkillSubscriberSpecs({
      skillSources: [triggerSkill, handlerSkill],
      runtime,
    });

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "loaded subscriber id=approval-review skill=approval-helper hasHandler=false",
      ),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "loaded subscriber id=bitable-record-log skill=bitable-log hasHandler=true",
      ),
    );
  });
});
