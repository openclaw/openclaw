import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import type { SpeechVoiceOption } from "openclaw/plugin-sdk/speech";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveActiveTalkProviderConfig } from "openclaw/plugin-sdk/talk-config-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

function mask(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= 6) {
    return "***";
  }
  return `${trimmed.slice(0, 6)}…`;
}

function isLikelyVoiceId(value: string): boolean {
  const v = value.trim();
  if (v.length < 10 || v.length > 64) {
    return false;
  }
  return /^[a-zA-Z0-9_-]+$/.test(v);
}

function resolveProviderLabel(providerId: string): string {
  switch (providerId) {
    case "openai":
      return "OpenAI";
    case "microsoft":
      return "Microsoft";
    case "elevenlabs":
      return "ElevenLabs";
    default:
      return providerId;
  }
}

const TALK_ADMIN_SCOPE = "operator.admin";
// The tool factory runs per invocation; a shared schema keeps host schema caches warm.
const TALK_VOICE_PARAMETERS = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "set"] },
    voice: { type: "string", description: "Voice ID from list; required for set." },
  },
  required: ["action"],
  additionalProperties: false,
};

export default definePluginEntry({
  id: "talk-voice",
  name: "Talk Voice",
  description: "Select the active Talk voice and manage Talk voice configuration",
  register(api: OpenClawPluginApi) {
    const loadTool = createLazyRuntimeModule(() => import("./tool.js"));
    api.registerTool(
      (ctx) => {
        const sessionKey = ctx.sessionKey;
        return {
          name: "talk_voice",
          label: "Talk Voice",
          description:
            "List or change the voice of the active realtime Talk call (browser, iOS, or Android) or Discord voice call in this conversation. Use list to see its provider, model, current voice, available voice IDs, and whether it can change. Use set with an available voice ID to reconnect the active call, preserving conversation and ongoing agent work. Success means the replacement call is ready. Saved voice defaults stay unchanged.",
          parameters: TALK_VOICE_PARAMETERS,
          execute: async (...args) =>
            await (await loadTool()).executeTalkVoiceTool(sessionKey, ...args),
        };
      },
      { name: "talk_voice" },
    );
    api.registerCommand({
      name: "voice",
      nativeNames: {
        discord: "talkvoice",
      },
      description: "List/set Talk provider voices (affects iOS Talk playback).",
      acceptsArgs: true,
      exposeSenderIsOwner: true,
      handler: async (ctx) => {
        const assertOwnerCurrent = ctx.assertOwnerCurrent;
        const commandLabel = ctx.channel === "discord" ? "/talkvoice" : "/voice";
        const args = ctx.args?.trim() ?? "";
        const tokens = args.split(/\s+/).filter(Boolean);
        const action = normalizeLowercaseStringOrEmpty(tokens[0] ?? "status");

        const cfg = api.runtime.config.current() as OpenClawConfig;
        const active = resolveActiveTalkProviderConfig(cfg.talk);
        if (!active) {
          return {
            text:
              "Talk voice is not configured.\n\n" +
              "Missing: talk.provider and talk.providers.<provider>.\n" +
              "Set it on the gateway, then retry.",
          };
        }
        const providerId = active.provider;
        const providerLabel = resolveProviderLabel(providerId);
        const apiKey = normalizeOptionalString(active.config.apiKey);
        const baseUrl = normalizeOptionalString(active.config.baseUrl);

        const currentVoiceId = normalizeOptionalString(active.config.voiceId);

        if (action === "status") {
          return {
            text:
              "Talk voice status:\n" +
              `- provider: ${providerId}\n` +
              `- talk.providers.${providerId}.voiceId: ${currentVoiceId ? currentVoiceId : "(unset)"}\n` +
              `- ${providerId}.apiKey: ${apiKey ? mask(apiKey) : "(unset)"}`,
          };
        }

        if (action === "list") {
          const limit = parseStrictPositiveInteger(tokens[1]) ?? 12;
          try {
            const voices = await api.runtime.tts.listVoices({
              provider: providerId,
              cfg,
              apiKey: apiKey || undefined,
              baseUrl,
            });
            const sliced = voices.slice(0, Math.max(1, Math.min(limit, 50)));
            const lines: string[] = [];
            lines.push(`${providerLabel} voices: ${voices.length}`);
            lines.push("");
            for (const v of sliced) {
              const name = (v.name ?? "").trim() || "(unnamed)";
              const category = (v.category ?? "").trim();
              const meta = category ? ` · ${category}` : "";
              lines.push(`- ${name}${meta}`);
              lines.push(`  id: ${v.id}`);
              const parts = [v.locale, v.gender];
              const personalities =
                v.personalities?.filter((value) => value.trim().length > 0) ?? [];
              if (personalities.length > 0) {
                parts.push(personalities.join(", "));
              }
              const filtered = parts.filter((part): part is string => Boolean(part?.trim()));
              const details = filtered.length > 0 ? filtered.join(" · ") : undefined;
              if (details) {
                lines.push(`  meta: ${details}`);
              }
              const description = (v.description ?? "").trim();
              if (description) {
                lines.push(`  note: ${description}`);
              }
            }
            if (voices.length > sliced.length) {
              lines.push("");
              lines.push(`(showing first ${sliced.length})`);
            }
            return { text: lines.join("\n") };
          } catch (error) {
            const message = formatErrorMessage(error);
            return { text: `${providerLabel} voice list failed: ${message}` };
          }
        }

        if (action === "set") {
          // Persistent Talk voice changes are gateway config writes, so the
          // mutating subcommand requires explicit admin or owner authority.
          const { senderIsOwner, gatewayClientScopes } = ctx;
          const requiresAdmin = Array.isArray(gatewayClientScopes)
            ? !gatewayClientScopes.includes(TALK_ADMIN_SCOPE)
            : senderIsOwner !== true;
          if (requiresAdmin) {
            return { text: `⚠️ ${commandLabel} set requires operator.admin.` };
          }

          const query = tokens.slice(1).join(" ").trim();
          if (!query) {
            return { text: `Usage: ${commandLabel} set <voiceId|name>` };
          }
          let voices: SpeechVoiceOption[];
          try {
            voices = await api.runtime.tts.listVoices({
              provider: providerId,
              cfg,
              apiKey: apiKey || undefined,
              baseUrl,
            });
          } catch (error) {
            const message = formatErrorMessage(error);
            return { text: `${providerLabel} voice lookup failed: ${message}` };
          }
          const lower = normalizeLowercaseStringOrEmpty(query);
          const chosen =
            voices.find((v) => v.id === query) ??
            voices.find((v) => normalizeOptionalLowercaseString(v.name) === lower) ??
            voices.find((v) => normalizeLowercaseStringOrEmpty(v.name).includes(lower)) ??
            null;
          if (!chosen) {
            const hint = isLikelyVoiceId(query) ? query : `"${query}"`;
            return { text: `No voice found for ${hint}. Try: ${commandLabel} list` };
          }

          await api.runtime.config.mutateConfigFile({
            afterWrite: { mode: "auto" },
            writeOptions: {
              assertCurrent: Array.isArray(ctx.gatewayClientScopes)
                ? undefined
                : assertOwnerCurrent,
            },
            mutate: (draft) => {
              draft.talk = {
                ...draft.talk,
                provider: providerId,
                providers: {
                  ...draft.talk?.providers,
                  [providerId]: {
                    ...draft.talk?.providers?.[providerId],
                    voiceId: chosen.id,
                  },
                },
              };
            },
          });

          const name = (chosen.name ?? "").trim() || "(unnamed)";
          return { text: `✅ ${providerLabel} Talk voice set to ${name}\n${chosen.id}` };
        }

        return {
          text: [
            "Voice commands:",
            "",
            `${commandLabel} status`,
            `${commandLabel} list [limit]`,
            `${commandLabel} set <voiceId|name>`,
          ].join("\n"),
        };
      },
    });
  },
});
