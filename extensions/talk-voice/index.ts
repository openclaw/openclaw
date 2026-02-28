import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type ElevenLabsVoice = {
  voice_id: string;
  name?: string;
  category?: string;
  description?: string;
};

function mask(s: string, keep: number = 6): string {
  const trimmed = s.trim();
  if (trimmed.length <= keep) {
    return "***";
  }
  return `${trimmed.slice(0, keep)}…`;
}

function isLikelyVoiceId(value: string): boolean {
  const v = value.trim();
  if (v.length < 10 || v.length > 64) {
    return false;
  }
  return /^[a-zA-Z0-9_-]+$/.test(v);
}

async function listVoices(apiKey: string): Promise<ElevenLabsVoice[]> {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: {
      "xi-api-key": apiKey,
    },
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs voices API error (${res.status})`);
  }
  const json = (await res.json()) as { voices?: ElevenLabsVoice[] };
  return Array.isArray(json.voices) ? json.voices : [];
}

function formatVoiceList(voices: ElevenLabsVoice[], limit: number): string {
  const sliced = voices.slice(0, Math.max(1, Math.min(limit, 50)));
  const lines: string[] = [];
  lines.push(`Voices: ${voices.length}`);
  lines.push("");
  for (const v of sliced) {
    const name = (v.name ?? "").trim() || "(unnamed)";
    const category = (v.category ?? "").trim();
    const meta = category ? ` · ${category}` : "";
    lines.push(`- ${name}${meta}`);
    lines.push(`  id: ${v.voice_id}`);
  }
  if (voices.length > sliced.length) {
    lines.push("");
    lines.push(`(showing first ${sliced.length})`);
  }
  return lines.join("\n");
}

function findVoice(voices: ElevenLabsVoice[], query: string): ElevenLabsVoice | null {
  const q = query.trim();
  if (!q) {
    return null;
  }
  const lower = q.toLowerCase();
  const byId = voices.find((v) => v.voice_id === q);
  if (byId) {
    return byId;
  }
  const exactName = voices.find((v) => (v.name ?? "").trim().toLowerCase() === lower);
  if (exactName) {
    return exactName;
  }
  const partial = voices.find((v) => (v.name ?? "").trim().toLowerCase().includes(lower));
  return partial ?? null;
}

export default function register(api: OpenClawPluginApi) {
  api.registerCommand({
    name: "voice",
    description: "List/set ElevenLabs Talk voice (affects iOS Talk playback).",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim() ?? "";
      const tokens = args.split(/\s+/).filter(Boolean);
      const action = (tokens[0] ?? "status").toLowerCase();

      const cfg = api.runtime.config.loadConfig();
      const apiKey = (cfg.talk?.apiKey ?? "").trim();
      if (!apiKey) {
        return {
          text:
            "Talk voice is not configured.\n\n" +
            "Missing: talk.apiKey (ElevenLabs API key).\n" +
            "Set it on the gateway, then retry.",
        };
      }

      const currentVoiceId = (cfg.talk?.voiceId ?? "").trim();

      if (action === "status") {
        return {
          text:
            "Talk voice status:\n" +
            `- talk.voiceId: ${currentVoiceId ? currentVoiceId : "(unset)"}\n` +
            `- talk.apiKey: ${mask(apiKey)}`,
        };
      }

      if (action === "list") {
        const limit = Number.parseInt(tokens[1] ?? "12", 10);
        const voices = await listVoices(apiKey);
        return { text: formatVoiceList(voices, Number.isFinite(limit) ? limit : 12) };
      }

      if (action === "set") {
        const query = tokens.slice(1).join(" ").trim();
        if (!query) {
          return { text: "Usage: /voice set <voiceId|name>" };
        }
        const voices = await listVoices(apiKey);
        const chosen = findVoice(voices, query);
        if (!chosen) {
          const hint = isLikelyVoiceId(query) ? query : `"${query}"`;
          return { text: `No voice found for ${hint}. Try: /voice list` };
        }

        const nextConfig = {
          ...cfg,
          talk: {
            ...cfg.talk,
            voiceId: chosen.voice_id,
          },
        };
        await api.runtime.config.writeConfigFile(nextConfig);

        const name = (chosen.name ?? "").trim() || "(unnamed)";
        return { text: `✅ Talk voice set to ${name}\n${chosen.voice_id}` };
      }

      return {
        text: [
          "Voice commands:",
          "",
          "/voice status",
          "/voice list [limit]",
          "/voice set <voiceId|name>",
        ].join("\n"),
      };
    },
  });
}
