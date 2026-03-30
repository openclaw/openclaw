import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir } from "../tools/common.js";
import { SkillCreator } from "./creator.js";
import { SkillNudge } from "./nudge.js";
import { SkillRegistry } from "./registry.js";
import type { SkillLoopConfig } from "./types.js";

export function registerSkillLoop(
  api: OpenClawPluginApi,
  config: { skillLoop?: SkillLoopConfig },
): void {
  const log = api.logger;
  const slConfig = config.skillLoop ?? {};
  const workspaceDir = resolveWorkspaceDir(api);
  const defaultSkillPath = join(workspaceDir, "skills");

  const registry = new SkillRegistry(slConfig.skillPaths ?? [defaultSkillPath]);
  const creator = new SkillCreator(registry);
  const nudge = new SkillNudge(creator, slConfig.creationNudgeInterval ?? 10);

  // Scan existing skills on startup
  registry.scan().catch((err) => log.warn(`[skill-loop] Initial scan failed: ${err}`));

  // Tool: skill_list
  api.registerTool({
    name: "skill_list",
    label: "List Skills",
    description: "List all installed skills with their descriptions and tags.",
    parameters: Type.Object({}),
    async execute() {
      await registry.scan();
      const skills = registry.list();
      if (skills.length === 0) return textResult("No skills installed.");
      const lines = skills.map(
        (s) =>
          `${s.name} (v${s.manifest.version}) — ${s.manifest.description.slice(0, 100)} [${s.manifest.tags.join(", ")}]`,
      );
      return textResult(`Installed skills (${skills.length}):\n${lines.join("\n")}`);
    },
  } as AnyAgentTool);

  // Tool: skill_search
  api.registerTool({
    name: "skill_search",
    label: "Search Skills",
    description: "Search for skills by keyword, tag, or description.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),
    async execute(_id: string, params: { query: string }) {
      await registry.scan();
      const results = registry.search(params.query);
      if (results.length === 0) return textResult(`No skills found for "${params.query}".`);
      const lines = results.map((s) => `${s.name} — ${s.manifest.description.slice(0, 100)}`);
      return textResult(
        `Skills matching "${params.query}" (${results.length}):\n${lines.join("\n")}`,
      );
    },
  } as AnyAgentTool);

  // Tool: skill_create
  api.registerTool({
    name: "skill_create",
    label: "Create Skill",
    description: "Create a new skill from a description. Generates SKILL.md and manifest.json.",
    parameters: Type.Object({
      name: Type.String({ description: "Skill name (kebab-case)" }),
      description: Type.String({ description: "What the skill does" }),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags" })),
      content: Type.Optional(Type.String({ description: "SKILL.md content (markdown)" })),
    }),
    async execute(
      _id: string,
      params: { name: string; description: string; tags?: string[]; content?: string },
    ) {
      const skillDir = join(defaultSkillPath, params.name);
      await mkdir(skillDir, { recursive: true });

      const manifest = {
        name: params.name,
        version: "1.0.0",
        description: params.description,
        author: "operator",
        tags: params.tags ?? [],
        createdAt: new Date().toISOString(),
      };

      const content =
        params.content ?? `# ${params.description}\n\n## Steps\n\n1. TODO: Define skill steps\n`;

      await writeFile(join(skillDir, "manifest.json"), JSON.stringify(manifest, null, 2));
      await writeFile(join(skillDir, "SKILL.md"), content);

      registry.addSkill({ name: params.name, path: skillDir, manifest, content });

      return textResult(`Skill "${params.name}" created at ${skillDir}`);
    },
  } as AnyAgentTool);

  // Tool: skill_run
  api.registerTool({
    name: "skill_run",
    label: "Run Skill",
    description: "Load and display a named skill's instructions for execution.",
    parameters: Type.Object({
      name: Type.String({ description: "Skill name to run" }),
    }),
    async execute(_id: string, params: { name: string }) {
      const skill = registry.get(params.name);
      if (!skill)
        return textResult(
          `Skill "${params.name}" not found. Use skill_list to see available skills.`,
        );
      return textResult(`[SKILL: ${skill.name}]\n\n${skill.content}`);
    },
  } as AnyAgentTool);

  // Hook: nudge skill creation on session end
  api.on("session_end", async (ctx: Record<string, unknown>) => {
    try {
      const proposal = await nudge.onSessionEnd({
        taskDescription: ctx.taskDescription as string | undefined,
        toolsUsed: ctx.toolsUsed as string[] | undefined,
        outcome: ctx.outcome as string | undefined,
        agentId: ctx.agentId as string | undefined,
        sessionId: ctx.sessionId as string | undefined,
      });
      if (proposal) {
        log.info(
          `[skill-loop] Skill proposal: "${proposal.name}" (confidence: ${proposal.confidence.toFixed(2)})`,
        );
      }
    } catch (err) {
      log.warn(`[skill-loop] Nudge failed: ${err}`);
    }
  });

  log.info(`[skill-loop] Skill loop initialized (paths: ${registry["paths"].join(", ")})`);
}

export { SkillRegistry } from "./registry.js";
export { SkillCreator } from "./creator.js";
export { SkillNudge } from "./nudge.js";
