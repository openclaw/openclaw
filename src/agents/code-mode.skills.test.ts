/** Tests Code Mode skills and read tools. */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../skills/loading/skill-contract.js";
import { buildSkillSnapshot } from "../skills/loading/workspace-skill-prompt.js";
import { createFixtureSkillEntry } from "../skills/test-support/test-helpers.js";
import { createOpenClawReadTool } from "./agent-tools.read.js";
import { resolveCodeModeSkills } from "./code-mode-skills.js";
import { applyCodeModeCatalog, runCodeModeScriptHeadless } from "./code-mode.js";
import {
  resetCodeModeTestState,
  pluginTool,
  createCodeModeHarness,
  createHeadlessCodeModeHarness,
  runUntilCompleted,
} from "./code-mode.test-support.js";
import { createReadTool } from "./sessions/index.js";

function skillCandidate(params: {
  name: string;
  description: string;
  filePath: string;
  readContent?: string;
}): Skill {
  return {
    ...params,
    baseDir: params.filePath.replace(/\/[^/]+$/u, ""),
    sourceInfo: {
      path: params.filePath,
      source: "test",
      scope: "temporary",
      origin: "top-level",
    },
    disableModelInvocation: false,
    source: "test",
  };
}

describe("Code Mode skills and read tools", () => {
  it.each([undefined, false, true])(
    "gates headless skill search with the same opt-in (%s)",
    async (enabled) => {
      const ctx = createHeadlessCodeModeHarness();
      ctx.config = { ...ctx.config, skills: { experimental: { search: enabled } } };
      ctx.runtimeConfig = ctx.config;
      const result = await runCodeModeScriptHeadless({
        ctx,
        code: `
      return typeof skills.search === "function" ? await skills.search("missing") : "off";
    `,
      });
      expect(result.status).toBe("completed");
      if (result.status === "completed") {
        expect(result.value).toEqual(enabled === true ? [] : "off");
      }
    },
  );

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCodeModeTestState();
  });

  it("searches and reads eligible skills omitted from the prompt without exposing manual-only skills", async () => {
    const entries = ["alpha", "release", "manual"].map((name) => createFixtureSkillEntry(name));
    entries[1]!.skill.description = "Prepare a release and verify publishing checks";
    entries[1]!.skill.readContent =
      "# Complete release procedure\nVerify checks before publishing.\nEND";
    entries[2]!.skill.disableModelInvocation = true;
    entries[2]!.invocation = { userInvocable: true, disableModelInvocation: true };
    const snapshot = await buildSkillSnapshot("/workspace", {
      entries,
      config: { skills: { experimental: { search: true }, limits: { maxSkillsInPrompt: 1 } } },
    });
    expect(snapshot.prompt).toContain("<name>alpha</name>");
    expect(snapshot.prompt).not.toContain("<name>release</name>");
    const codeModeSkills = resolveCodeModeSkills({
      candidates: snapshot.resolvedSkills!,
    });
    const { tools, config, catalogRef } = createCodeModeHarness({
      codeModeSkills,
      skillSearchEnabled: true,
    });
    applyCodeModeCatalog({
      tools: [...tools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "skill-search",
      sessionKey: "agent:main:main",
      runId: "skill-search",
      catalogRef,
      codeModeSkills,
    });
    const details = await runUntilCompleted({
      execTool: expectDefined(tools[0], "exec test invariant"),
      waitTool: expectDefined(tools[1], "wait test invariant"),
      code: `
        const matches = await skills.search("release publishing", { limit: 1 });
        const body = await skills.read(matches[0].name);
        const manual = await skills.search("manual");
        const none = await skills.search("xylophone");
        return { names: matches.map(s => s.name), body, manual, none };
      `,
    });
    expect(details.status, JSON.stringify(details)).toBe("completed");
    expect(details.value).toEqual({
      names: ["release"],
      body: entries[1]!.skill.readContent,
      manual: [],
      none: [],
    });
  });

  it.each([undefined, false])(
    "keeps search absent and list/read prompt-limited when the lab is %s",
    async (enabled) => {
      const entries = ["alpha", "release"].map((name) => createFixtureSkillEntry(name));
      entries[0]!.skill.readContent = "Complete alpha instructions";
      const snapshot = await buildSkillSnapshot("/workspace", {
        entries,
        config: { skills: { limits: { maxSkillsInPrompt: 1 }, experimental: { search: enabled } } },
      });
      const codeModeSkills = resolveCodeModeSkills({ candidates: snapshot.resolvedSkills! });
      const { tools, config, catalogRef } = createCodeModeHarness({
        codeModeSkills,
        skillSearchEnabled: enabled,
      });
      applyCodeModeCatalog({
        tools: [...tools, pluginTool("fake_noop", "Noop")],
        config,
        sessionId: "skill-off",
        sessionKey: "agent:main:main",
        runId: "skill-off",
        catalogRef,
        codeModeSkills,
      });
      expect(tools[0]!.description).not.toContain("skills.search");
      const result = await runUntilCompleted({
        execTool: tools[0]!,
        waitTool: tools[1]!,
        code: `
      let omittedRejected = false;
      try { await skills.read("release"); } catch { omittedRejected = true; }
      return { search: typeof skills.search, names: (await skills.list()).map(s => s.name),
        body: await skills.read("alpha"), omittedRejected };
    `,
      });
      expect(result.status, JSON.stringify(result)).toBe("completed");
      expect(result.value).toEqual({
        search: "undefined",
        names: ["alpha"],
        body: "Complete alpha instructions",
        omittedRejected: true,
      });
    },
  );

  it("lists and reads policy-selected skills through the worker bridge", async () => {
    const demo = skillCandidate({
      name: "demo",
      description: "Full demo description",
      filePath: "/guest/skills/demo/SKILL.md",
    });
    const hidden = skillCandidate({
      name: "hidden",
      description: "Hidden skill",
      filePath: "/host/skills/hidden/SKILL.md",
    });
    hidden.disableModelInvocation = true;
    const reader = vi.fn(async ({ location }: { location: string }) =>
      location === "/guest/skills/demo/SKILL.md"
        ? "---\nname: demo\n---\n\n# Complete demo instructions\n"
        : "# Hidden\n",
    );
    const codeModeSkills = resolveCodeModeSkills({
      candidates: [demo, hidden],
      reader,
    });
    const {
      config,
      catalogRef,
      tools: codeModeTools,
    } = createCodeModeHarness({
      codeModeSkills,
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
      codeModeSkills,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        const listed = await skills.list();
        const body = await skills.read("demo");
        let unknown;
        try {
          await skills.read("missing");
        } catch (error) {
          unknown = error.message;
        }
        return { listed, body, unknown };
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      listed: [
        {
          name: "demo",
          description: "Full demo description",
          location: "/guest/skills/demo/SKILL.md",
        },
      ],
      body: "---\nname: demo\n---\n\n# Complete demo instructions\n",
      unknown: 'Unknown skill "missing". Available skills: demo',
    });
    expect(codeModeTools[0]?.description).toContain("`await skills.read(name)`");
    expect(reader).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledWith({
      location: "/guest/skills/demo/SKILL.md",
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    {
      name: "existing ordinary file",
      path: "notes.txt",
      content: "ordinary file content",
      expected: { kind: "text", content: "ordinary file content" },
    },
    {
      name: "missing implicitly optional daily memory",
      path: "memory/2026-05-15.md",
      expected: {
        kind: "not_found",
        status: "not_found",
        path: "memory/2026-05-15.md",
        optional: true,
      },
    },
  ])(
    "returns $name through the wrapped Code Mode boundary",
    async ({ path, content, expected }) => {
      const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
      const read = createOpenClawReadTool(
        createReadTool("/workspace", {
          operations: {
            access: async () => {
              if (content === undefined) {
                throw Object.assign(new Error("missing"), { code: "ENOENT" });
              }
            },
            readFile: async () => Buffer.from(content ?? "unreachable"),
          },
        }) as unknown as Parameters<typeof createOpenClawReadTool>[0],
      );
      applyCodeModeCatalog({
        tools: [...codeModeTools, read],
        config,
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode",
        catalogRef,
      });

      const details = await runUntilCompleted({
        execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
        waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
        code: `return await read(${JSON.stringify({ path })});`,
      });

      expect(details).toMatchObject({ status: "completed", value: expected });
    },
  );
});
