/**
 * VibeClaw Tools
 * Agent tools for searching, installing, and managing skills via Vibe Index.
 */

import { VibeIndexClient } from "./vibe-index-client.js";
import type { VibeResource } from "./vibe-index-client.js";
import { installSkillFromGitHub, listInstalledSkills, uninstallSkill, getInstalledSkillMeta } from "./skill-installer.js";

export interface VibeClawConfig {
  searchOnly: boolean;
  allowedPublishers: string[] | null;
}

/**
 * Check Vibe Index security scan data and block unsafe skills.
 * Returns an error message if the skill should not be installed, or null if safe.
 */
function checkSecurity(skill: VibeResource): string | null {
  // Cisco deep scan says unsafe → block
  if (skill.cisco_scan_result && !skill.cisco_scan_result.is_safe) {
    const sev = skill.cisco_scan_result.max_severity;
    const count = skill.cisco_scan_result.findings_count;
    return (
      `⛔ BLOCKED: "${skill.name}" failed Vibe Index security scan.\n\n` +
      `  Severity: ${sev}\n` +
      `  Findings: ${count} issue(s) detected\n` +
      (skill.security_flags?.length
        ? `  Flags: ${skill.security_flags.join(", ")}\n`
        : "") +
      `\nThis skill has known security issues and cannot be installed.\n` +
      `See https://vibeindex.ai for details.`
    );
  }

  // Pre-scan score >= 25 → block (warning/critical threshold)
  if (skill.security_score !== null && skill.security_score >= 25) {
    return (
      `⛔ BLOCKED: "${skill.name}" has a high security risk score (${skill.security_score}).\n\n` +
      (skill.security_flags?.length
        ? `  Flags: ${skill.security_flags.join(", ")}\n`
        : "") +
      `\nThis skill has been flagged by Vibe Index security scanning and cannot be installed.\n` +
      `See https://vibeindex.ai for details.`
    );
  }

  return null;
}

/**
 * Check if a publisher is in the allowlist.
 */
function checkAllowlist(skill: VibeResource, allowedPublishers: string[] | null): string | null {
  if (!allowedPublishers || allowedPublishers.length === 0) return null;
  const owner = skill.github_owner;
  if (!owner) {
    return `⛔ BLOCKED: "${skill.name}" has no GitHub owner. Cannot verify publisher.`;
  }
  const allowed = allowedPublishers.map(p => p.toLowerCase());
  if (!allowed.includes(owner.toLowerCase())) {
    return (
      `⛔ BLOCKED: "${skill.name}" is published by "${owner}", which is not in your allowlist.\n\n` +
      `  Allowed publishers: ${allowedPublishers.join(", ")}\n\n` +
      `To allow this publisher, add "${owner}" to plugins.entries.vibeclaw.config.allowedPublishers`
    );
  }
  return null;
}

/**
 * Format security status for display after successful install.
 */
function formatSecurityBadge(skill: VibeResource): string {
  if (skill.cisco_scan_result?.is_safe) {
    return "🛡️ Verified safe (Cisco scan)";
  }
  if (skill.security_score === 0) {
    return "🛡️ Pre-scanned (no issues)";
  }
  if (skill.security_score !== null && skill.security_score > 0 && skill.security_score < 25) {
    return `⚠️ Minor flags (score: ${skill.security_score})`;
  }
  return "🔍 Scan pending";
}

function formatResource(r: VibeResource, index: number): string {
  const stars = r.star_info?.count ?? r.stars ?? 0;
  const badges: string[] = [];
  if (r.badges?.official || r.is_official) badges.push("Official");
  if (r.badges?.verified || r.is_verified) badges.push("Verified");
  if (r.badges?.trending) badges.push("Trending");

  const badgeStr = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
  const desc = r.description
    ? r.description.length > 120
      ? r.description.slice(0, 120) + "..."
      : r.description
    : "No description";
  const typeLabel = r.resource_type.toUpperCase();

  let result = `${index}. **${r.name}** (${typeLabel}) — ⭐ ${stars}${badgeStr}\n`;
  result += `   ${desc}\n`;
  result += `   Security: ${formatSecurityBadge(r)}\n`;
  if (r.github_url) result += `   GitHub: ${r.github_url}\n`;
  return result;
}

/**
 * vibeclaw_search — Search Vibe Index for skills/plugins/MCP servers
 */
export function createSearchTool(client: VibeIndexClient) {
  return {
    name: "vibeclaw_search",
    description:
      "Search the Vibe Index ecosystem (93,600+ resources) for skills, plugins, MCP servers, and marketplaces. " +
      "Use this when the user needs a capability you don't currently have, or when they ask about available tools. " +
      "Returns ranked results. After finding a skill, use vibeclaw_install to install it directly.",
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query describing the capability needed (e.g., 'email', 'github pr', 'weather', 'pdf reader')",
        },
        type: {
          type: "string",
          enum: ["skill", "plugin", "mcp", "marketplace"],
          description: "Filter by resource type. Omit to search all types.",
        },
        limit: {
          type: "number",
          description: "Number of results to return (1-10, default 5)",
        },
      },
      required: ["query"],
    },
    execute: async (args: { query: string; type?: string; limit?: number }) => {
      try {
        const result = await client.search(args.query, {
          type: args.type,
          limit: args.limit ?? 5,
        });

        if (!result.success || result.data.length === 0) {
          return { content: `No results found for "${args.query}" in the Vibe Index ecosystem.` };
        }

        const total = result.pagination?.total ?? result.data.length;
        let output = `Found ${total} results for "${args.query}" in Vibe Index:\n\n`;
        output += result.data.map((r, i) => formatResource(r, i + 1)).join("\n");
        output += `\nUse vibeclaw_install to install any of these skills directly.`;

        return { content: output };
      } catch (err) {
        return { content: `Error searching Vibe Index: ${(err as Error).message}` };
      }
    },
  };
}

/**
 * vibeclaw_install — Download and install a skill from GitHub via Vibe Index
 */
export function createInstallTool(client: VibeIndexClient, config: VibeClawConfig) {
  return {
    name: "vibeclaw_install",
    description:
      "Install a skill directly from GitHub into OpenClaw. Downloads the SKILL.md file and places it " +
      "in ~/.openclaw/skills/ so OpenClaw loads it automatically. Use after vibeclaw_search finds a skill " +
      "the user wants. The skill becomes available on the next agent session.",
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Skill name or search query to find and install",
        },
        force: {
          type: "boolean",
          description: "Reinstall even if already installed (default: false)",
        },
      },
      required: ["query"],
    },
    execute: async (args: { query: string; force?: boolean }) => {
      // Search-only mode: block all installs
      if (config.searchOnly) {
        return {
          content:
            "⛔ Installation is disabled. This VibeClaw instance is configured in search-only mode.\n\n" +
            "Use vibeclaw_search to find skills, then install them manually.\n" +
            "To enable installation, set plugins.entries.vibeclaw.config.searchOnly to false.",
        };
      }

      try {
        // Search Vibe Index for the skill
        const searchResult = await client.search(args.query, { type: "skill", limit: 1 });

        if (!searchResult.success || searchResult.data.length === 0) {
          return { content: `Could not find skill "${args.query}" in Vibe Index.` };
        }

        const skill = searchResult.data[0];

        if (!skill.github_owner || !skill.github_repo) {
          return {
            content: `Found "${skill.name}" but it has no GitHub repository. Cannot install automatically.\n` +
              (skill.github_url ? `Manual link: ${skill.github_url}` : ""),
          };
        }

        // Allowlist gate: check if publisher is approved
        const allowlistBlock = checkAllowlist(skill, config.allowedPublishers);
        if (allowlistBlock) {
          return { content: allowlistBlock };
        }

        // Security gate: check Vibe Index scan results before installing
        const securityBlock = checkSecurity(skill);
        if (securityBlock) {
          return { content: securityBlock };
        }

        // Install by downloading SKILL.md from GitHub
        const result = await installSkillFromGitHub(
          skill.github_owner,
          skill.github_repo,
          skill.slug || skill.name,
          { force: args.force },
        );

        if (!result.success) {
          return { content: `Failed to install "${skill.name}": ${result.error}` };
        }

        if (result.alreadyInstalled) {
          return {
            content: `"${skill.name}" is already installed at ${result.installPath}.\n` +
              `Use force: true to reinstall.\n` +
              `The skill is available in your next agent session.`,
          };
        }

        let output = `✓ Installed "${result.skillName}" successfully!\n\n`;
        output += `  Location: ${result.installPath}\n`;
        output += `  Source: ${result.sourceUrl}\n`;
        output += `  Publisher: ${skill.github_owner}\n`;
        output += `  Stars: ⭐ ${skill.stars}\n`;
        output += `  Security: ${formatSecurityBadge(skill)}\n`;
        if (skill.description) output += `  Description: ${skill.description}\n`;
        output += `\n**The skill will be available in your next agent session.**\n`;
        output += `Restart the agent or start a new session to use it.`;

        return { content: output };
      } catch (err) {
        return { content: `Error installing skill: ${(err as Error).message}` };
      }
    },
  };
}

/**
 * vibeclaw_trending — Show trending resources
 */
export function createTrendingTool(client: VibeIndexClient) {
  return {
    name: "vibeclaw_trending",
    description:
      "Get trending skills, plugins, and MCP servers from the Vibe Index ecosystem. " +
      "Shows what's gaining the most stars recently. Use when the user asks what's popular or trending.",
    parameters: {
      type: "object" as const,
      properties: {
        period: {
          type: "string",
          enum: ["day", "week", "month"],
          description: "Time period for trending calculation (default: week)",
        },
        type: {
          type: "string",
          enum: ["skill", "plugin", "mcp", "marketplace"],
          description: "Filter by resource type",
        },
        limit: {
          type: "number",
          description: "Number of results (1-10, default 5)",
        },
      },
    },
    execute: async (args: { period?: string; type?: string; limit?: number }) => {
      try {
        const result = await client.trending({
          period: (args.period as "day" | "week" | "month") ?? "week",
          type: args.type,
          limit: args.limit ?? 5,
        });

        if (!result.success || result.data.length === 0) {
          return { content: "No trending data available right now." };
        }

        const periodLabel = args.period === "day" ? "today" : args.period === "month" ? "this month" : "this week";
        let output = `Trending ${args.type ?? "resources"} ${periodLabel} on Vibe Index:\n\n`;

        for (let i = 0; i < result.data.length; i++) {
          const r = result.data[i];
          const growth = r.star_growth ? ` (+${r.star_growth} ⭐)` : "";
          output += formatResource(r, i + 1);
          if (growth) output += `   Growth: ${growth}\n`;
          output += "\n";
        }

        output += `Use vibeclaw_install to install any of these.`;
        return { content: output };
      } catch (err) {
        return { content: `Error fetching trending: ${(err as Error).message}` };
      }
    },
  };
}

/**
 * vibeclaw_manage — List/uninstall VibeClaw-installed skills
 */
export function createManageTool() {
  return {
    name: "vibeclaw_manage",
    description:
      "List or uninstall skills that were installed via VibeClaw. " +
      "Use 'list' to see all VibeClaw-installed skills, or 'uninstall' to remove one.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["list", "uninstall"],
          description: "Action to perform",
        },
        skillName: {
          type: "string",
          description: "Skill name to uninstall (required for uninstall action)",
        },
      },
      required: ["action"],
    },
    execute: async (args: { action: string; skillName?: string }) => {
      if (args.action === "list") {
        const skills = await listInstalledSkills();
        if (skills.length === 0) {
          return { content: "No skills installed via VibeClaw yet." };
        }
        let output = `VibeClaw-installed skills (${skills.length}):\n\n`;
        for (const name of skills) {
          output += `  - ${name}\n`;
        }
        return { content: output };
      }

      if (args.action === "uninstall") {
        if (!args.skillName) {
          return { content: "Please specify which skill to uninstall." };
        }
        const removed = await uninstallSkill(args.skillName);
        if (removed) {
          return { content: `✓ Uninstalled "${args.skillName}". It will be removed on next session.` };
        }
        return { content: `"${args.skillName}" was not found or was not installed via VibeClaw.` };
      }

      return { content: `Unknown action: ${args.action}` };
    },
  };
}

/**
 * vibeclaw_audit — Re-check installed skills against latest Vibe Index security data.
 * If a skill was safe when installed but has since been flagged, this tool warns the user.
 */
export function createAuditTool(client: VibeIndexClient) {
  return {
    name: "vibeclaw_audit",
    description:
      "Audit all VibeClaw-installed skills against the latest Vibe Index security data. " +
      "Detects skills that were safe when installed but have since been flagged. " +
      "Use periodically or when concerned about installed skill safety.",
    parameters: {
      type: "object" as const,
      properties: {},
    },
    execute: async () => {
      try {
        const skills = await listInstalledSkills();
        if (skills.length === 0) {
          return { content: "No VibeClaw-installed skills to audit." };
        }

        const results: { name: string; status: string; detail: string }[] = [];

        for (const name of skills) {
          const meta = await getInstalledSkillMeta(name);
          const searchResult = await client.search(name, { type: "skill", limit: 1 });

          if (!searchResult.success || searchResult.data.length === 0) {
            results.push({ name, status: "⚠️", detail: "Not found in Vibe Index (may have been removed)" });
            continue;
          }

          const skill = searchResult.data[0];
          const securityIssue = checkSecurity(skill);

          if (securityIssue) {
            results.push({
              name,
              status: "⛔ FLAGGED",
              detail: `Security issue detected since installation.\n` +
                (skill.security_flags?.length ? `      Flags: ${skill.security_flags.join(", ")}\n` : "") +
                `      Score: ${skill.security_score ?? "N/A"}\n` +
                `      Action: Run vibeclaw_manage uninstall "${name}" to remove.`,
            });
          } else {
            const badge = formatSecurityBadge(skill);
            const installedAt = meta?.installedAt ? ` (installed ${meta.installedAt.split("T")[0]})` : "";
            results.push({ name, status: "✓", detail: `${badge}${installedAt}` });
          }
        }

        const flagged = results.filter(r => r.status.includes("FLAGGED"));
        const safe = results.filter(r => r.status === "✓");
        const unknown = results.filter(r => r.status === "⚠️");

        let output = `VibeClaw Security Audit — ${skills.length} skill(s) checked\n\n`;

        if (flagged.length > 0) {
          output += `🚨 ${flagged.length} skill(s) need attention:\n\n`;
          for (const r of flagged) {
            output += `  ${r.status} ${r.name}\n      ${r.detail}\n\n`;
          }
        }

        if (safe.length > 0) {
          output += `✓ ${safe.length} skill(s) are safe:\n`;
          for (const r of safe) {
            output += `  ${r.status} ${r.name} — ${r.detail}\n`;
          }
          output += "\n";
        }

        if (unknown.length > 0) {
          output += `⚠️ ${unknown.length} skill(s) could not be verified:\n`;
          for (const r of unknown) {
            output += `  ${r.status} ${r.name} — ${r.detail}\n`;
          }
          output += "\n";
        }

        if (flagged.length === 0 && unknown.length === 0) {
          output += "All installed skills passed the security check.";
        } else if (flagged.length === 0 && unknown.length > 0) {
          output += `No flagged skills, but ${unknown.length} skill(s) could not be verified.`;
        } else {
          output += `⚠️ ${flagged.length} skill(s) should be uninstalled immediately.`;
        }

        return { content: output };
      } catch (err) {
        return { content: `Error running audit: ${(err as Error).message}` };
      }
    },
  };
}
