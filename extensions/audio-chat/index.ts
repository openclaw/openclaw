import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Bump this string whenever you want to confirm which build is loaded at runtime.
const BUILD_FINGERPRINT = "audio-chat@2026-03-06a";

// Debug / forensics toggles.
// Keep this OFF in normal use to avoid log spam and extra disk writes.
const DEBUG_FORENSICS = false;

const PLUGIN_ID = "audio-chat";

const DEFAULT_MAX_CHARS = 150;
const DEFAULT_TOO_LONG_TIP = "本次回复字数过长未发语音";
const DEFAULT_VOICE = "zh-CN-YunxiaNeural";

type AudioChatPluginConfig = {
  enabledByDefault: boolean;
  channels: string[];
  defaultMaxChars: number;
  tooLongTip: string;
  voice: string;
  access: {
    directOnly: boolean;
    allowUserIds: string[];
  };
};

function normalizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.map((x) => String(x ?? "").trim()).filter(Boolean);
}

function getPluginConfig(api: any): AudioChatPluginConfig {
  const cfg = api?.runtime?.config?.loadConfig?.() ?? {};
  const root = cfg?.extensions?.audioChat ?? cfg?.audioChat ?? {};
  const access = root?.access ?? {};

  const channels = normalizeStringList(root?.channels);
  const allowUserIds = normalizeStringList(access?.allowUserIds);

  const maxCharsRaw = Number(root?.defaultMaxChars);
  const defaultMaxChars =
    Number.isFinite(maxCharsRaw) && maxCharsRaw >= 10 && maxCharsRaw <= 5000
      ? maxCharsRaw
      : DEFAULT_MAX_CHARS;

  return {
    enabledByDefault: Boolean(root?.enabledByDefault ?? false),
    channels: channels.length > 0 ? channels : ["telegram"],
    defaultMaxChars,
    tooLongTip: String(root?.tooLongTip ?? DEFAULT_TOO_LONG_TIP).trim() || DEFAULT_TOO_LONG_TIP,
    voice: String(root?.voice ?? DEFAULT_VOICE).trim() || DEFAULT_VOICE,
    access: {
      directOnly: Boolean(access?.directOnly ?? true),
      allowUserIds,
    },
  };
}

function isChannelAllowed(cfg: AudioChatPluginConfig, channel: string): boolean {
  return cfg.channels.includes(channel);
}

function isUserAllowed(cfg: AudioChatPluginConfig, userId?: string | null): boolean {
  const id = String(userId ?? "").trim();
  if (cfg.access.allowUserIds.length === 0) return true;
  if (!id) return false;
  return cfg.access.allowUserIds.includes(id);
}

// Pin edge-tts to a dedicated virtualenv to avoid breakage when Homebrew python upgrades.
const AUDIO_CHAT_VENV_PYTHON = path.join(
  process.env.HOME ?? "",
  ".openclaw",
  "venvs",
  "audio-chat",
  "bin",
  "python",
);

function stripMarkdownForTTS(input: string): string {
  let s = String(input ?? "");

  // 0) Remove OpenClaw reply tags (e.g. [[reply_to_current]]) that should never be spoken.
  s = s.replace(/^\s*\[\[[^\]]+\]\]\s*/g, "");

  // 1) Fenced code blocks -> placeholder (avoid reading long code/symbol soup)
  // ```lang\n...\n```
  s = s.replace(/```[\s\S]*?```/g, "\n（代码略）\n");

  // 2) Inline code: keep the content, just drop backticks.
  // This avoids the annoying "这里有一段代码" being read for small inline snippets.
  s = s.replace(/`([^`]*)`/g, "$1");

  // 3) Links: [title](url) -> title
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");

  // 4) Bare URLs -> drop
  s = s.replace(/https?:\/\/\S+/g, "");

  // 5) Common markdown markers
  // Keep the words, drop markers.
  s = s
    .replace(/[*_~]/g, "") // emphasis/strikethrough markers
    .replace(/^\s{0,3}#+\s+/gm, "") // headings
    .replace(/^\s*>\s?/gm, "") // blockquotes
    .replace(/^\s*[-+•]\s+/gm, ""); // list bullets

  // 6) Cleanup whitespace
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/[ \t]{2,}/g, " ");

  return s.trim();
}

type VoiceState = {
  version: number;
  updatedAt: number;
  entries: Record<
    string,
    {
      enabled: boolean;
      maxChars: number;
      updatedAt: number;
    }
  >;
};

function nowMs() {
  return Date.now();
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveEdgeTtsPython() {
  // Prefer pinned venv python; fallback to system python3 for backward compatibility.
  if (AUDIO_CHAT_VENV_PYTHON && (await pathExists(AUDIO_CHAT_VENV_PYTHON))) {
    return AUDIO_CHAT_VENV_PYTHON;
  }
  return "python3";
}

function isTelegramDirectSessionKey(sessionKey?: string) {
  return typeof sessionKey === "string" && sessionKey.includes(":telegram:direct:");
}

function sessionKeyToChatId(sessionKey: string): string | null {
  // agent:main:telegram:direct:<chatId>
  const m = sessionKey.match(/:telegram:direct:(\d+)$/);
  return m?.[1] ?? null;
}

function makeEntryKeyFromSessionKey(sessionKey: string) {
  // Keep it explicit in case other surfaces reuse ids.
  const chatId = sessionKeyToChatId(sessionKey);
  if (!chatId) return null;
  return `telegram:direct:${chatId}`;
}

async function loadState(stateDir: string, logger: any): Promise<VoiceState> {
  const file = path.join(stateDir, "audio-chat.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("bad state");
    return {
      version: typeof parsed.version === "number" ? parsed.version : 1,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : nowMs(),
      entries: typeof parsed.entries === "object" && parsed.entries ? parsed.entries : {},
    } as VoiceState;
  } catch (err: any) {
    if (err?.code !== "ENOENT")
      logger.warn?.(
        `[${PLUGIN_ID}] state load failed; using empty: ${String(err?.message ?? err)}`,
      );
    return { version: 1, updatedAt: nowMs(), entries: {} };
  }
}

async function saveState(stateDir: string, state: VoiceState) {
  const file = path.join(stateDir, "audio-chat.json");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export default function register(api: any) {
  const logger = api.logger;
  const stateDir = api.runtime.state.resolveStateDir(api.config);

  // Startup fingerprint: helps verify which exact file/version the gateway loaded.
  // This should appear exactly once after each gateway restart.
  (async () => {
    try {
      const filePath = fileURLToPath(import.meta.url);
      const st = await fs.stat(filePath);
      logger.info?.(
        `[${PLUGIN_ID}] boot fingerprint=${BUILD_FINGERPRINT} file=${filePath} mtimeMs=${st.mtimeMs} size=${st.size}`,
      );
    } catch (err: any) {
      logger.warn?.(
        `[${PLUGIN_ID}] boot fingerprint failed: ${String(err?.message ?? err)} (fingerprint=${BUILD_FINGERPRINT})`,
      );
    }

    // Startup healthcheck: verify edge-tts and ffmpeg availability.
    try {
      const py = await resolveEdgeTtsPython();
      await api.runtime.system.runCommandWithTimeout([py, "-m", "edge_tts", "--help"], {
        timeoutMs: 15_000,
      });
      await api.runtime.system.runCommandWithTimeout(["ffmpeg", "-version"], {
        timeoutMs: 15_000,
      });
      logger.info?.(`[${PLUGIN_ID}] deps ok (python=${py}, ffmpeg=ok)`);
    } catch (err: any) {
      logger.warn?.(
        `[${PLUGIN_ID}] deps check failed: ${String(err?.message ?? err)}. ` +
          `Fix: python3 -m venv ~/.openclaw/venvs/audio-chat && ` +
          `~/.openclaw/venvs/audio-chat/bin/python -m pip install -U pip edge-tts`,
      );
    }
  })();

  async function setEnabledBySessionKey(sessionKey: string, enabled: boolean) {
    const entryKey = makeEntryKeyFromSessionKey(sessionKey);
    if (!entryKey) throw new Error(`Unsupported sessionKey: ${sessionKey}`);

    const state = await loadState(stateDir, logger);
    const prev = state.entries[entryKey];
    state.entries[entryKey] = {
      enabled,
      maxChars: prev?.maxChars ?? getPluginConfig(api).defaultMaxChars,
      updatedAt: nowMs(),
    };
    state.updatedAt = nowMs();
    await saveState(stateDir, state);

    return state.entries[entryKey];
  }

  async function getBySessionKey(sessionKey: string) {
    const entryKey = makeEntryKeyFromSessionKey(sessionKey);
    if (!entryKey) return null;
    const state = await loadState(stateDir, logger);
    return state.entries[entryKey] ?? null;
  }

  // /audio_chat on|off|status
  api.registerCommand({
    name: "audio_chat",
    description: "Toggle Telegram voice bubble mode: /audio_chat on|off|status",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const pluginCfg = getPluginConfig(api);

      // NOTE: PluginCommandContext.channel is the surface ("telegram"), channelId may be undefined.
      if (!isChannelAllowed(pluginCfg, String(ctx.channel ?? ""))) {
        return { text: `audio_chat：当前仅支持 ${pluginCfg.channels.join(", ")}。` };
      }

      const senderId = String(ctx.senderId ?? "").trim();
      if (!isUserAllowed(pluginCfg, senderId)) {
        return { text: "audio_chat：当前账号无权限使用该命令。" };
      }

      // Reconstruct sessionKey. Prefer `to` (chat id), fallback to sender.
      const rawTo = ctx.to ? String(ctx.to) : "";
      const rawFrom = ctx.from ? String(ctx.from) : "";
      const chatId = rawTo.match(/(\d+)$/)?.[1] ?? rawFrom.match(/(\d+)$/)?.[1] ?? senderId;

      if (!chatId) {
        return { text: "audio_chat：无法识别当前会话目标。" };
      }

      const sessionKey = `agent:main:telegram:direct:${chatId}`;

      const arg = (ctx.args ?? "").trim().toLowerCase();
      if (!arg || arg === "status") {
        const entry = await getBySessionKey(sessionKey);
        const enabled = entry?.enabled ?? pluginCfg.enabledByDefault;
        const maxChars = entry?.maxChars ?? pluginCfg.defaultMaxChars;
        return {
          text: [
            `audio_chat 状态：${enabled ? "ON" : "OFF"}`,
            `频道：${pluginCfg.channels.join(", ")}`,
            `阈值：${maxChars} 字（超过则提示“${pluginCfg.tooLongTip}”并不发语音）`,
          ].join("\n"),
        };
      }

      if (arg === "on" || arg === "enable" || arg === "1") {
        const entry = await setEnabledBySessionKey(sessionKey, true);
        return { text: `audio_chat 已开启（阈值 ${entry.maxChars} 字）。` };
      }

      if (arg === "off" || arg === "disable" || arg === "0") {
        const entry = await setEnabledBySessionKey(sessionKey, false);
        return { text: "audio_chat 已关闭。" };
      }

      // /audio_chat max 200
      if (arg.startsWith("max")) {
        const m = (ctx.args ?? "").trim().match(/^max\s+(\d+)$/i);
        const n = m ? Number(m[1]) : NaN;
        if (!Number.isFinite(n) || n < 10 || n > 5000) {
          return { text: "用法：/audio_chat max <数字>（范围 10-5000）" };
        }

        const entryKey = makeEntryKeyFromSessionKey(sessionKey);
        if (!entryKey) throw new Error(`Unsupported sessionKey: ${sessionKey}`);

        const state = await loadState(stateDir, logger);
        const prev = state.entries[entryKey];
        state.entries[entryKey] = {
          enabled: prev?.enabled ?? pluginCfg.enabledByDefault,
          maxChars: n,
          updatedAt: nowMs(),
        };
        state.updatedAt = nowMs();
        await saveState(stateDir, state);

        return {
          text: `audio_chat 阈值已设置为 ${n} 字（当前：${state.entries[entryKey].enabled ? "ON" : "OFF"}）。`,
        };
      }

      return {
        text: "用法：/audio_chat on | /audio_chat off | /audio_chat status | /audio_chat max <数字>",
      };
    },
  });

  // v2 (方案一): do NOT rely on prompt injection. Auto-send voice bubble after text is sent.
  // We debounce per chat to avoid duplicate voice sends when text is chunked.
  const pendingByChat = new Map<
    string,
    {
      timer: NodeJS.Timeout;
      lastText: string;
      lastUpdatedAt: number;
    }
  >();
  const outboundSeenAtByChat = new Map<string, number>();
  const lastVoiceSentByChat = new Map<string, { text: string; at: number }>();

  function extractChatIdFromTo(to: string): string | null {
    // Accept: "850..." / "-100..." or "telegram:850..." / "telegram:-100..." etc.
    const m = String(to).match(/(-?\d+)$/);
    return m?.[1] ?? null;
  }

  function isLikelyGroupTarget(to: string, chatId: string | null): boolean {
    if (String(to).includes(":group:")) return true;
    if (!chatId) return false;
    // Telegram groups/supergroups are negative chat ids (commonly -100...)
    return chatId.startsWith("-");
  }

  function resolveSendMessageTelegram() {
    const sendMessageTelegram =
      api?.runtime?.channels?.telegram?.sendMessageTelegram ??
      api?.runtime?.channel?.telegram?.sendMessageTelegram ??
      api?.runtime?.telegram?.sendMessageTelegram;
    if (typeof sendMessageTelegram !== "function") {
      throw new Error(
        `Telegram send API not available (runtime keys=${Object.keys(api?.runtime ?? {}).join(",")})`,
      );
    }
    return sendMessageTelegram;
  }

  const tooLongNotifiedAtByChat = new Map<string, number>();

  async function maybeSendTooLongTip(params: {
    to: string;
    chatId: string;
    maxChars: number;
    textLen: number;
    tipText: string;
    accountId?: string;
  }) {
    // Avoid loops and avoid spamming when multiple hooks fire.
    const now = nowMs();
    const last = tooLongNotifiedAtByChat.get(params.chatId) ?? 0;
    if (now - last < 2000) return;
    tooLongNotifiedAtByChat.set(params.chatId, now);

    const tipText = `${params.tipText}（${params.textLen}/${params.maxChars}）`;

    try {
      const sendMessageTelegram = resolveSendMessageTelegram();
      await sendMessageTelegram(params.to, tipText, {
        ...(params.accountId ? { accountId: params.accountId } : {}),
      });
      logger.info?.(
        `[${PLUGIN_ID}] too-long tip sent (chatId=${params.chatId} len=${params.textLen} max=${params.maxChars})`,
      );
    } catch (err: any) {
      logger.warn?.(`[${PLUGIN_ID}] too-long tip failed: ${String(err?.message ?? err)}`);
    }
  }

  async function synthAndSendVoice(params: {
    to: string;
    text: string;
    maxChars: number;
    accountId?: string;
  }) {
    const textRaw = (params.text ?? "").trim();
    const text = stripMarkdownForTTS(textRaw);
    if (!text) return;
    if (text.length > params.maxChars) return;

    if (DEBUG_FORENSICS) {
      // Debug: confirm markdown stripping works (truncate to avoid log spam).
      const rawHasStar = textRaw.includes("*");
      const cleanedHasStar = text.includes("*");
      logger.info?.(
        `[${PLUGIN_ID}] tts-prep rawHasStar=${rawHasStar} cleanHasStar=${cleanedHasStar} preview=${JSON.stringify(text.slice(0, 80))}`,
      );
    }

    const mediaRoot = path.join(stateDir, "media", "audio-chat");
    await fs.mkdir(mediaRoot, { recursive: true });
    const ts = Date.now();
    const mp3Path = path.join(mediaRoot, `audio-chat-${ts}.mp3`);
    const oggPath = path.join(mediaRoot, `audio-chat-${ts}.ogg`);

    const cfg = api.runtime.config.loadConfig();
    const pluginCfg = getPluginConfig(api);
    const voice =
      String(cfg?.messages?.tts?.edge?.voice ?? pluginCfg.voice).trim() || pluginCfg.voice;

    if (DEBUG_FORENSICS) {
      // Debug: persist the exact text passed to TTS (for troubleshooting)
      try {
        await fs.writeFile(path.join(mediaRoot, `audio-chat-${ts}.txt`), text + "\n", "utf8");
      } catch (err: any) {
        logger.warn?.(`[${PLUGIN_ID}] write txt failed: ${String(err?.message ?? err)}`);
      }
    }

    try {
      // 1) Edge TTS -> mp3
      const edgeTtsPython = await resolveEdgeTtsPython();
      await api.runtime.system.runCommandWithTimeout(
        [
          edgeTtsPython,
          "-m",
          "edge_tts",
          "--voice",
          voice,
          "--text",
          text,
          "--write-media",
          mp3Path,
        ],
        { timeoutMs: 60_000 },
      );

      // 2) ffmpeg mp3 -> ogg/opus
      await api.runtime.system.runCommandWithTimeout(
        [
          "ffmpeg",
          "-y",
          "-i",
          mp3Path,
          "-ar",
          "48000",
          "-ac",
          "1",
          "-c:a",
          "libopus",
          "-b:a",
          "32k",
          oggPath,
        ],
        { timeoutMs: 60_000 },
      );

      // 3) send voice bubble (asVoice=true)
      // NOTE: Telegram send supports local media paths under allowed roots.
      const sendMessageTelegram = resolveSendMessageTelegram();

      await sendMessageTelegram(params.to, "", {
        mediaUrl: oggPath,
        asVoice: true,
        ...(params.accountId ? { accountId: params.accountId } : {}),
      });
    } finally {
      // Best-effort cleanup to avoid unbounded media growth.
      await Promise.allSettled([fs.unlink(mp3Path), fs.unlink(oggPath)]);
    }
  }

  async function handleOutboundHook(phase: "sending" | "sent", event: any, ctx: any) {
    try {
      const channelId = String(ctx?.channelId ?? "");
      const to = String(event?.to ?? "");
      const content = String(event?.content ?? "");
      logger.info?.(
        `[${PLUGIN_ID}] hook:${phase} channelId=${channelId} to=${to} len=${content.trim().length} success=${String(event?.success ?? "")}`,
      );

      const pluginCfg = getPluginConfig(api);

      // Only act on configured outbound channels after successful delivery.
      if (!isChannelAllowed(pluginCfg, channelId)) return;
      if (!event?.success) return;

      const chatId = extractChatIdFromTo(to);
      if (!chatId) return;
      if (pluginCfg.access.directOnly && isLikelyGroupTarget(to, chatId)) return;
      if (!isUserAllowed(pluginCfg, chatId)) return;

      const sessionKey = `agent:main:telegram:direct:${chatId}`;
      const entry = await getBySessionKey(sessionKey);
      const enabled = entry?.enabled ?? pluginCfg.enabledByDefault;
      if (!enabled) return;

      const maxChars = entry?.maxChars ?? pluginCfg.defaultMaxChars;
      const trimmed = content.trim();
      if (!trimmed) return;

      // (reply-to cache removed)

      // Don't react to our own tip (tip adds suffix like "（len/max）").
      if (trimmed.startsWith(pluginCfg.tooLongTip)) return;

      if (trimmed.length > maxChars) {
        await maybeSendTooLongTip({
          to,
          chatId,
          maxChars,
          textLen: trimmed.length,
          tipText: pluginCfg.tooLongTip,
          accountId: String(ctx?.accountId ?? "") || undefined,
        });
        return;
      }

      const key = chatId;
      outboundSeenAtByChat.set(key, nowMs());

      const prev = pendingByChat.get(key);
      if (prev) clearTimeout(prev.timer);

      const timer = setTimeout(async () => {
        const cur = pendingByChat.get(key);
        if (!cur) return;
        pendingByChat.delete(key);
        try {
          const lastSent = lastVoiceSentByChat.get(key);
          if (lastSent && lastSent.text === cur.lastText && nowMs() - lastSent.at < 10_000) {
            return;
          }

          await synthAndSendVoice({
            to,
            text: cur.lastText,
            maxChars,
            accountId: String(ctx?.accountId ?? "") || undefined,
          });
          lastVoiceSentByChat.set(key, { text: cur.lastText, at: nowMs() });
          logger.info?.(`[${PLUGIN_ID}] voice-sent ok (to=${to})`);
        } catch (err: any) {
          logger.warn?.(`[${PLUGIN_ID}] auto-voice failed: ${String(err?.message ?? err)}`);
        }
      }, 650);

      pendingByChat.set(key, {
        timer,
        lastText: trimmed,
        lastUpdatedAt: nowMs(),
      });
    } catch (err: any) {
      logger.warn?.(`[${PLUGIN_ID}] hook handler error: ${String(err?.message ?? err)}`);
    }
  }

  // NOTE: Prefer message_sent (post-delivery) to avoid speaking messages that later fail/cancel.
  // Keep agent_end as a guarded fallback for paths where outbound hooks may not fire.
  api.on("message_sent", async (event: any, ctx: any) => {
    await handleOutboundHook("sent", event, ctx);
  });

  api.on("agent_end", async (event: any, ctx: any) => {
    try {
      const pluginCfg = getPluginConfig(api);
      if (event?.success === false) return;

      const sessionKey = String(ctx?.sessionKey ?? "");
      if (!isTelegramDirectSessionKey(sessionKey)) return;
      if (pluginCfg.access.directOnly && !sessionKey.includes(":direct:")) return;

      const chatId = sessionKeyToChatId(sessionKey);
      if (!chatId) return;
      if (!isUserAllowed(pluginCfg, chatId)) return;

      // If outbound hook already observed this chat very recently, skip fallback to avoid duplicate voice sends.
      const outboundSeenAt = outboundSeenAtByChat.get(chatId) ?? 0;
      if (nowMs() - outboundSeenAt < 4_000) return;

      const entry = await getBySessionKey(sessionKey);
      const enabled = entry?.enabled ?? pluginCfg.enabledByDefault;
      if (!enabled) return;

      const maxChars = entry?.maxChars ?? pluginCfg.defaultMaxChars;

      const msgs: any[] = Array.isArray(event?.messages) ? event.messages : [];
      const lastAssistant = [...msgs].reverse().find((m) => m && m.role === "assistant");
      let text = "";
      if (typeof lastAssistant?.content === "string") text = lastAssistant.content;
      else if (Array.isArray(lastAssistant?.content)) {
        // OpenAI-style content parts
        const parts = lastAssistant.content
          .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
          .filter(Boolean);
        text = parts.join("\n");
      }

      const trimmed = String(text ?? "").trim();
      logger.info?.(
        `[${PLUGIN_ID}] hook:agent_end sessionKey=${sessionKey} len=${trimmed.length} success=${String(event?.success ?? "")}`,
      );

      if (DEBUG_FORENSICS) {
        // Forensics: record the *exact* assistant text we intend to pass into TTS (before stripMarkdownForTTS).
        // Dual-channel logging: logger + console (so we can see it in both gateway.log and /tmp/openclaw/*.log).
        // Keep it short to avoid log spam.
        try {
          const rawHasStar = trimmed.includes("*");
          const cleaned = stripMarkdownForTTS(trimmed);
          const cleanHasStar = cleaned.includes("*");
          const rawPreview = trimmed.slice(0, 80).replace(/\s+/g, " ");
          const cleanPreview = cleaned.slice(0, 80).replace(/\s+/g, " ");
          const line = `[${PLUGIN_ID}] agent_end rawText rawLen=${trimmed.length} cleanLen=${cleaned.length} rawHasStar=${rawHasStar} cleanHasStar=${cleanHasStar} rawPreview=${JSON.stringify(rawPreview)} cleanPreview=${JSON.stringify(cleanPreview)}`;
          logger.info?.(line);
          // eslint-disable-next-line no-console
          console.log(line);
        } catch (err: any) {
          const msg = `[${PLUGIN_ID}] agent_end rawText forensics failed: ${String(err?.message ?? err)}`;
          logger.warn?.(msg);
          // eslint-disable-next-line no-console
          console.warn(msg);
        }
      }

      if (!trimmed) return;

      // Don't react to our own tip (tip adds suffix like "（len/max）").
      if (trimmed.startsWith(pluginCfg.tooLongTip)) return;

      if (trimmed.length > maxChars) {
        await maybeSendTooLongTip({
          to: chatId,
          chatId,
          maxChars,
          textLen: trimmed.length,
          tipText: pluginCfg.tooLongTip,
          accountId: String(ctx?.accountId ?? "") || undefined,
        });
        return;
      }

      // Reuse same debounce map (keyed by chatId)
      const key = chatId;
      const prev = pendingByChat.get(key);
      if (prev) clearTimeout(prev.timer);

      const timer = setTimeout(async () => {
        const cur = pendingByChat.get(key);
        if (!cur) return;
        pendingByChat.delete(key);
        try {
          const lastSent = lastVoiceSentByChat.get(key);
          if (lastSent && lastSent.text === cur.lastText && nowMs() - lastSent.at < 10_000) {
            return;
          }

          await synthAndSendVoice({
            to: chatId,
            text: cur.lastText,
            maxChars,
            accountId: String(ctx?.accountId ?? "") || undefined,
          });
          lastVoiceSentByChat.set(key, { text: cur.lastText, at: nowMs() });
          logger.info?.(`[${PLUGIN_ID}] voice-sent ok (agent_end to=${chatId})`);
        } catch (err: any) {
          logger.warn?.(
            `[${PLUGIN_ID}] agent_end auto-voice failed: ${String(err?.message ?? err)}`,
          );
        }
      }, 650);

      pendingByChat.set(key, {
        timer,
        lastText: trimmed,
        lastUpdatedAt: nowMs(),
      });
    } catch (err: any) {
      logger.warn?.(`[${PLUGIN_ID}] agent_end handler error: ${String(err?.message ?? err)}`);
    }
  });

  logger.info(`[${PLUGIN_ID}] loaded (stateDir=${stateDir}) fingerprint=${BUILD_FINGERPRINT}`);
}
