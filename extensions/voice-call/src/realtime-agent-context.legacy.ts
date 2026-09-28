import { resolveAgentIdentity, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { root } from "openclaw/plugin-sdk/security-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { VoiceCallConfig } from "./config.js";

function limitLegacyContextText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const truncated = `${truncateUtf16Safe(text, Math.max(0, maxChars - 32)).trimEnd()}\n[truncated]`;
  // Count the marker against tiny positive budgets too.
  return truncateUtf16Safe(truncated, maxChars);
}

// Preserve the shipped 2026.9.6 capsule until the supported host floor supplies the shared composer.
export async function buildLegacyRealtimeVoiceAgentContext(params: {
  config: VoiceCallConfig["realtime"]["agentContext"];
  coreConfig: OpenClawConfig;
  agentId: string;
}): Promise<string | undefined> {
  const { config, coreConfig, agentId } = params;
  if (!config.enabled) {
    return undefined;
  }
  const capsule = [
    "OpenClaw agent voice context:",
    `- Agent id: ${agentId}`,
    "- Use this context to match the OpenClaw agent's personality and standing preferences on fast voice turns.",
    "- Treat this as compact context only; call openclaw_agent_consult when the caller needs the full agent brain, tools, memory, or workspace state.",
  ];
  if (config.includeIdentity) {
    const identity = asOptionalRecord(resolveAgentIdentity(coreConfig, agentId));
    const fields = [
      ["Name", identity?.name],
      ["Emoji", identity?.emoji],
      ["Vibe", identity?.vibe],
      ["Theme", identity?.theme],
      ["Creature/persona", identity?.creature],
    ] as const;
    const lines = fields.flatMap(([label, value]) => {
      const text = normalizeOptionalString(value);
      return text ? [`- ${label}: ${text}`] : [];
    });
    if (lines.length > 0) {
      capsule.push(`Configured identity:\n${lines.join("\n")}`);
    }
  }
  if (config.includeWorkspaceFiles) {
    const workspace = await root(resolveAgentWorkspaceDir(coreConfig, agentId)).catch(() => null);
    if (workspace) {
      const sections: string[] = [];
      let remaining = config.maxChars;
      for (const file of config.files) {
        if (remaining <= 0) {
          continue;
        }
        const content = await workspace.readText(file).catch(() => undefined);
        const trimmed = content?.trim();
        if (!trimmed) {
          continue;
        }
        const body = limitLegacyContextText(trimmed, Math.max(0, remaining - file.length - 16));
        const section = `### ${file}\n${body}`;
        sections.push(section);
        remaining -= section.length;
      }
      if (sections.length > 0) {
        capsule.push(`Workspace voice context:\n${sections.join("\n\n")}`);
      }
    }
  }
  return limitLegacyContextText(capsule.join("\n\n"), config.maxChars);
}
