import {
  TELEGRAM_FULL_MCP_TRIGGERS,
  TELEGRAM_MCP_PLUGIN_MANIFESTS,
} from "./mcp-plugin-manifest.js";

export function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

/**
 * Normalize a Telegram slash command by extracting the first token
 * and stripping any @botname suffix (e.g. "/mcp_status@some_bot" -> "/mcp_status").
 */
export function normalizeTelegramSlashCommand(text: string): string {
  const firstToken = text.trim().split(/\s+/)[0] ?? "";
  return firstToken.replace(/@\w+$/, "").toLowerCase();
}

const TLDR_CAPABILITY = [
  "read → ✅ allow",
  "write/send/delete/costly/private_data/secret_access → ⏳ approval required",
  "financial_execution/destructive → ❌ denied",
  "empty capabilities → ❌ denied",
].join("\n");

export const MCP_STATUS_COMMANDS = new Set(["/mcp_status", "/mcp_plugins", "/plugin_status"]);

export function buildTelegramPluginStatusMessage(input?: {
  maxTriggersPerPlugin?: number;
}): string {
  const maxTriggers = input?.maxTriggersPerPlugin ?? 3;

  const lines: string[] = [
    "🧩 **MCP Plugins**",
    "",
    "_Telegram MCP 트리거용 플러그인 상태입니다._",
    "_OpenClaw 전체 플러그인 목록은 /plugins 명령을 사용하세요._",
  ];

  for (const manifest of TELEGRAM_MCP_PLUGIN_MANIFESTS) {
    lines.push("");
    lines.push(`**${escapeMarkdown(manifest.id)}**`);
    lines.push(`  · mode: ${manifest.catalogPolicy}`);
    lines.push(`  · default: ${manifest.defaultMode}`);
    lines.push(`  · telegram: ${manifest.telegramDefault ? "always" : "trigger only"}`);
    lines.push(`  · auto-call: ${manifest.autoCall ? "on" : "off"}`);

    const displayed = manifest.triggers.slice(0, maxTriggers);
    const remaining = manifest.triggers.length - maxTriggers;
    let triggerText = displayed.map((t) => `\`${escapeMarkdown(t)}\``).join(", ");
    if (remaining > 0) {
      triggerText += ` …+${remaining}`;
    }
    lines.push(`  · triggers: ${triggerText}`);

    lines.push(`  · approval: write/send/delete/costly/private/secret`);
    lines.push(`  · deny: financial/destructive`);
  }

  if (TELEGRAM_FULL_MCP_TRIGGERS.length > 0) {
    lines.push("");
    lines.push("**Full MCP**:");
    const fullTriggers = TELEGRAM_FULL_MCP_TRIGGERS.map((t) => `\`${escapeMarkdown(t)}\``).join(
      ", ",
    );
    lines.push(`  ${fullTriggers} → full catalog request`);
  }

  lines.push("");
  lines.push("**Capability Policy**:");
  lines.push(TLDR_CAPABILITY);

  return lines.join("\n");
}

export function isPluginCommand(text: string): boolean {
  const command = normalizeTelegramSlashCommand(text);
  return MCP_STATUS_COMMANDS.has(command);
}
