import { createHash } from "node:crypto";
import { grokPluginSetup, GROK_TOOL_TRANSLATION_NOTE } from "./plugin-equivalents.js";
import { renderGrokBotAvatar } from "./source/avatar.js";
import type { GrokSourceAgent } from "./source/types.js";

export type GrokWorkspaceFile = {
  path: string;
  content: string | Uint8Array;
  kind: "workspace" | "memory" | "skill";
  skillName?: string;
};

export function grokContentDigest(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function grokAvatarPath(agent: GrokSourceAgent): string | undefined {
  if (agent.avatar?.image) {
    return `assets/grok-avatar.${agent.avatar.image.extension}`;
  }
  return agent.avatar?.shape || agent.avatar?.color ? "assets/grok-avatar.svg" : undefined;
}

export function grokAgentIdentityDigest(agent: GrokSourceAgent): string {
  return grokContentDigest(
    JSON.stringify({ id: agent.id, name: agent.name, avatar: grokAvatarPath(agent) }),
  );
}

/** Render source text whole; imported skill instructions must not be shortened. */
export function renderGrokWorkspace(agent: GrokSourceAgent): {
  files: GrokWorkspaceFile[];
  warnings: string[];
} {
  const files: GrokWorkspaceFile[] = [];
  const warnings: string[] = [];
  const avatar = grokAvatarPath(agent);
  if (avatar && agent.avatar?.image) {
    files.push({ path: avatar, content: agent.avatar.image.bytes, kind: "workspace" });
  } else if (avatar) {
    const rendered = renderGrokBotAvatar(agent.avatar?.shape, agent.avatar?.color);
    files.push({ path: avatar, content: rendered.svg, kind: "workspace" });
    warnings.push(...rendered.warnings.map((warning) => warning.message));
  }
  files.push({
    path: "IDENTITY.md",
    kind: "workspace",
    content: `# Agent identity\n\n- Name: ${agent.name.replaceAll(/[\r\n]/g, " ")}\n${avatar ? `- Avatar: ${avatar}\n` : ""}`,
  });
  if (agent.instructions) {
    files.push({ path: "SOUL.md", content: agent.instructions, kind: "workspace" });
  }
  if (agent.memory.status === "complete" && agent.memory.value.length) {
    files.push({
      path: "MEMORY.md",
      kind: "memory",
      content: `# Imported Grok Bot memory\n\n${agent.memory.value.map((memory) => `## ${memory.kind ?? "memory"}${memory.createdAt ? ` · ${memory.createdAt}` : ""}\n\n${memory.content}`).join("\n\n")}\n`,
    });
  }
  const used = new Set<string>();
  for (const skill of agent.skills.value) {
    const base =
      skill.name
        .toLowerCase()
        .replaceAll(/[^a-z0-9-]+/g, "-")
        .replaceAll(/^-+|-+$/g, "")
        .slice(0, 64) || "imported-skill";
    let slug = base;
    for (let suffix = 2; used.has(slug); suffix++) {
      slug = `${base}-${suffix}`;
    }
    used.add(slug);
    files.push({
      path: `skills/${slug}/SKILL.md`,
      kind: "skill",
      skillName: skill.name,
      content: /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(skill.content)
        ? skill.content
        : `---\nname: ${JSON.stringify(slug)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.content}`,
    });
  }
  const limitations = [agent.memory, agent.skills, agent.automations, agent.plugins]
    .filter((section) => section.status !== "complete")
    .map((section) => section.reason ?? "The source did not supply this section completely.");
  files.push({
    path: "GROK-IMPORT.md",
    kind: "workspace",
    content: [
      "# Grok Bot migration",
      "",
      "Imported instructions, memory, and skills retain their source text. Grok-specific tools may require an OpenClaw equivalent. Consult the migration report for imported automations, integrations, and reconnect steps before relying on them.",
      ...(agent.gettingStarted
        ? [
            `\nThe source recommends running the ${JSON.stringify(agent.gettingStarted.skill)} skill to finish setup.`,
          ]
        : []),
      ...limitations.map((message) => `\n- ${message}`),
      ...(agent.plugins.value.length
        ? [
            "\n## Integration setup\n",
            GROK_TOOL_TRANSLATION_NOTE,
            ...agent.plugins.value.map((plugin) => {
              const equivalent = grokPluginSetup(plugin.pluginId);
              return `\n- ${plugin.name}: ${equivalent ? `${equivalent.name}. ${equivalent.setup}` : "No verified native mapping; manual setup required."}${plugin.description ? ` Source requirement: ${plugin.description}` : ""}`;
            }),
          ]
        : []),
      "",
    ].join("\n"),
  });
  return { files, warnings };
}
