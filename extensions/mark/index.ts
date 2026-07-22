/**
 * Session Mark plugin — bundled extension.
 *
 * Two responsibilities:
 * 1. Register the `/mark` text-command handler so typing `/mark wip` works.
 * 2. Export `buildMarkCommand` (in `src/command-definition.ts`) for the
 *    core command registry to build the sub-menu UI.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { MARK_PRESETS, MARK_SEPARATOR, matchMarkPreset, stripMarkPrefix } from "./commands-mark.shared.js";

function formatPresetList(): string {
  const lines = ["Available marks (use /mark <symbol|id|index|alias>):"];
  for (const p of MARK_PRESETS) {
    lines.push(`  ${p.symbol}  [${p.index}] ${p.id}  (${p.aliases.join(", ")})`);
  }
  lines.push("  /mark clear  →  remove mark");
  return lines.join("\n");
}

function resolveBaseLabel(entry: { label?: string; displayName?: string; sessionId: string }): string {
  return entry.label?.trim() || entry.displayName?.trim() || entry.sessionId;
}

export default definePluginEntry({
  id: "mark",
  name: "Session Mark",
  description: "Mark sessions with preset symbols via /mark command.",
  register(api) {
    api.registerCommand({
      name: "mark",
      description: "Mark session with a preset symbol (🚧 ✅ ⏸️ 🔥 📌 💡) or clear.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const arg = (ctx.args ?? "").trim();
        const argLower = arg.toLowerCase();

        if (!arg || argLower === "list") {
          return { text: formatPresetList() };
        }

        const isClear = argLower === "clear";
        const preset = isClear ? undefined : matchMarkPreset(arg);
        if (!isClear && !preset) {
          return { text: `❌ No mark matches "${arg}". Enter /mark to see options.` };
        }

        if (!ctx.sessionKey || !ctx.agentId) {
          return { text: "Mark is not available for this session." };
        }

        const patched = await patchSessionEntry({
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
          update: (entry) => {
            const current = entry.label?.trim() ?? "";
            const base = stripMarkPrefix(current || resolveBaseLabel(entry));

            if (isClear) {
              const hasMark = current.includes(MARK_SEPARATOR);
              if (!hasMark) return null;
              return { label: base || undefined };
            }
            return { label: `${preset!.symbol}${MARK_SEPARATOR}${base}` };
          },
        });

        if (!patched) {
          return { text: "No active session to mark." };
        }

        return isClear
          ? { text: "✅ Mark cleared." }
          : { text: `${preset!.symbol} Marked as "${preset!.id}".` };
      },
    });
  },
});
