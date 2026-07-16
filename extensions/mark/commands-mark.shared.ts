/** Shared mark constants — imported by both the plugin handler and the core command registry. */

export type MarkPreset = {
  symbol: string;
  id: string;
  index: number;
  aliases: readonly string[];
};

export const MARK_SEPARATOR = "\u2800";

export const MARK_PRESETS: readonly MarkPreset[] = [
  { symbol: "🚧", id: "In progress", index: 0, aliases: ["in-progress", "ongoing", "wip"] },
  { symbol: "✅", id: "Completed",     index: 1, aliases: ["done", "completed", "finished"] },
  { symbol: "⏸️", id: "Paused",       index: 2, aliases: ["paused", "hold", "suspended"] },
  { symbol: "🔥", id: "Urgent",       index: 3, aliases: ["urgent", "critical", "asap"] },
  { symbol: "📌", id: "Keep",         index: 4, aliases: ["pinned", "reference", "keep"] },
  { symbol: "💡", id: "Idea",         index: 5, aliases: ["idea", "spark", "note"] },
];

export function stripMarkPrefix(label: string): string {
  const idx = label.indexOf(MARK_SEPARATOR);
  return idx === -1 ? label : label.slice(idx + MARK_SEPARATOR.length);
}

export function matchMarkPreset(arg: string): MarkPreset | undefined {
  const lower = arg.toLowerCase();
  return MARK_PRESETS.find(
    (p) =>
      p.symbol === arg ||
      p.id.toLowerCase() === lower ||
      (/^\d+$/u.test(arg) && p.index === Number(arg)) ||
      p.aliases.some((a) => a.toLowerCase() === lower),
  );
}
