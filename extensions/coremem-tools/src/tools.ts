import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";

type PluginCfg = {
  defaultHours?: number;
  defaultLimit?: number;
  maxLimit?: number;
};

type FlashEntry = {
  id: string;
  timestamp: string;
  type: string;
  content: string;
  speaker: string;
  keywords: string[];
};

type WarmEntry = {
  id: string;
  timestamp: string;
  summary?: string;
  hook?: string;
  content?: string;
  type?: string;
  keywords: string[];
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function parsePositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function formatMeetingNotes(params: {
  entries: Array<{ timestamp: string; speaker?: string; type?: string; text: string }>;
  title: string;
}): string {
  const { entries, title } = params;

  const decisions: string[] = [];
  const actions: string[] = [];
  const notes: string[] = [];

  for (const e of entries) {
    const t = (e.type || "").toLowerCase();
    const text = e.text.trim();
    if (!text) {
      continue;
    }

    if (t === "decision" || text.toLowerCase().startsWith("we decided")) {
      decisions.push(text);
      continue;
    }

    if (t === "action" || t === "task" || text.toLowerCase().startsWith("task created:")) {
      actions.push(text);
      continue;
    }

    notes.push(text);
  }

  const lines: string[] = [];
  lines.push(title);

  const pushSection = (header: string, items: string[]) => {
    if (items.length === 0) {
      return;
    }
    lines.push("");
    lines.push(header);
    for (const item of items.slice(-20)) {
      lines.push(`- ${item}`);
    }
  };

  pushSection("Decisions", decisions);
  pushSection("Next actions", actions);
  pushSection("Notes", notes.slice(-30));

  if (decisions.length === 0 && actions.length === 0 && notes.length === 0) {
    lines.push("(No entries found in that window.)");
  }

  return lines.join("\n").trim();
}

async function loadCoreMemories() {
  const mod = (await import("@openclaw/core-memories")) as {
    getCoreMemories: () => Promise<{
      getFlashEntries: () => FlashEntry[];
      getWarmEntries: () => WarmEntry[];
      findByKeyword: (keyword: string) => { flash: FlashEntry[]; warm: WarmEntry[] };
    }>;
  };
  return mod.getCoreMemories();
}

export function createCorememRecentTool(api: OpenClawPluginApi) {
  return {
    name: "coremem_recent",
    description:
      "Summarize recent CoreMemories Flash/Warm entries as meeting-style bullet points (not a transcript).",
    parameters: Type.Object({
      hours: Type.Optional(Type.Number({ description: "Look back window in hours (default 48)." })),
      limit: Type.Optional(
        Type.Number({
          description:
            "Max number of entries to load (default 100). This is entry-count, not words. Hard capped.",
        }),
      ),
      includeWarm: Type.Optional(
        Type.Boolean({ description: "Include Warm layer entries too (default true)." }),
      ),
      preset: Type.Optional(
        Type.Union([Type.Literal("quick"), Type.Literal("normal"), Type.Literal("deep")]),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const cfg = (api.pluginConfig ?? {}) as PluginCfg;

      const preset = typeof params.preset === "string" ? params.preset : undefined;
      const presetLimit =
        preset === "quick" ? 20 : preset === "deep" ? 250 : preset === "normal" ? 100 : undefined;

      const hours =
        parsePositiveNumber(params.hours) ??
        (typeof cfg.defaultHours === "number" && cfg.defaultHours > 0 ? cfg.defaultHours : 48);

      const maxLimit =
        (typeof cfg.maxLimit === "number" && cfg.maxLimit > 0 ? cfg.maxLimit : 500) || 500;

      const limitRaw =
        presetLimit ??
        parsePositiveNumber(params.limit) ??
        (typeof cfg.defaultLimit === "number" && cfg.defaultLimit > 0 ? cfg.defaultLimit : 100);

      const limit = clamp(limitRaw, 1, maxLimit);

      const includeWarm = typeof params.includeWarm === "boolean" ? params.includeWarm : true;

      const cm = await loadCoreMemories();
      const cutoff = Date.now() - hours * 60 * 60 * 1000;

      const flash = cm
        .getFlashEntries()
        .filter((e) => new Date(e.timestamp).getTime() >= cutoff)
        .slice(-limit)
        .map((e) => ({
          timestamp: e.timestamp,
          speaker: e.speaker,
          type: e.type,
          text: e.content,
        }));

      const warm = includeWarm
        ? cm
            .getWarmEntries()
            .filter((e) => new Date(e.timestamp).getTime() >= cutoff)
            .slice(-Math.floor(limit / 2))
            .map((e) => ({
              timestamp: e.timestamp,
              speaker: "warm",
              type: e.type,
              text: e.hook || e.summary || e.content || "",
            }))
        : [];

      const merged = [...flash, ...warm].toSorted(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );

      const text = formatMeetingNotes({
        title: `CoreMemories recap (last ~${hours}h, up to ${limit} entries)`,
        entries: merged,
      });

      return {
        content: [{ type: "text", text }],
        details: { hours, limit, includeWarm, counts: { flash: flash.length, warm: warm.length } },
      };
    },
  };
}

export function createCorememFindTool(api: OpenClawPluginApi) {
  return {
    name: "coremem_find",
    description:
      "Find CoreMemories entries by keyword and summarize matches as meeting-style bullet points.",
    parameters: Type.Object({
      keyword: Type.String({ description: "Keyword to search for." }),
      limit: Type.Optional(
        Type.Number({
          description: "Max number of matching entries to include (default 50, hard capped).",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const cfg = (api.pluginConfig ?? {}) as PluginCfg;
      const keyword = typeof params.keyword === "string" ? params.keyword.trim() : "";
      if (!keyword) {
        throw new Error("keyword required");
      }

      const maxLimit =
        (typeof cfg.maxLimit === "number" && cfg.maxLimit > 0 ? cfg.maxLimit : 500) || 500;
      const limitRaw =
        parsePositiveNumber(params.limit) ??
        (typeof cfg.defaultLimit === "number" && cfg.defaultLimit > 0 ? cfg.defaultLimit : 50);
      const limit = clamp(limitRaw, 1, maxLimit);

      const cm = await loadCoreMemories();
      const results = cm.findByKeyword(keyword);

      const matches = [...results.flash, ...results.warm]
        .map((e) => ({
          timestamp: e.timestamp,
          speaker: (e as FlashEntry).speaker ?? "",
          type: (e as FlashEntry).type ?? (e as WarmEntry).type ?? "",
          text:
            (e as FlashEntry).content ??
            (e as WarmEntry).hook ??
            (e as WarmEntry).summary ??
            (e as WarmEntry).content ??
            "",
        }))
        .filter((e) => e.text.trim())
        .toSorted(
          (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        )
        .slice(-limit);

      const text = formatMeetingNotes({
        title: `CoreMemories matches for "${keyword}" (up to ${limit} entries)`,
        entries: matches,
      });

      return {
        content: [{ type: "text", text }],
        details: {
          keyword,
          limit,
          counts: { flash: results.flash.length, warm: results.warm.length },
        },
      };
    },
  };
}
