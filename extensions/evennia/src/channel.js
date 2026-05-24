import { readReactionParams } from "openclaw/plugin-sdk/channel-actions";
import { createChannelPluginBase, createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { createChannelHistoryWindow } from "openclaw/plugin-sdk/reply-history";
import { Type } from "typebox";
import { EvenniaClient } from "./evennia-client.js";

const clients = new Map();
const evenniaHistories = new Map();

const ROOM_CONTEXT_MAX_CHARS = 5000;
const HELP_CONTEXT_MAX_CHARS = 2500;
const COMMAND_OUTPUT_MAX_CHARS = 6000;
const COMMAND_OUTPUT_WAIT_MS = 3000;
const COMMAND_ROOM_SNAPSHOT_MAX_CHARS = 3500;
const DEFAULT_EVENNIA_HISTORY_LIMIT = 20;
const DEFAULT_EVENNIA_TIMEOUT_SECONDS = 0;
const DEFAULT_EVENNIA_BLOCK_REPLY_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CHANNEL_ID = "evennia";

const EVENNIA_AGENT_PROMPT = [
  "You are acting as an Evennia MUD character through the Evennia channel.",
  "Use normal text replies when you want to speak in-character.",
  "Before each turn, OpenClaw may include a fresh `look` snapshot and cached `help` output in your context. Treat those as the authoritative room state.",
  "If the user asks you to look around, inspect exits, inspect objects, or check available actions, use the evennia_command tool (`look`, `help`, `examine <thing>`, etc.) before answering.",
  "When you want to perform an in-world action or run an Evennia command, call the evennia_command tool with exactly that command instead of saying the command aloud.",
  "Never say text like `evennia_command(command=...)`; that is not an action. Use the actual tool call.",
  "Examples of commands to send through the tool: look, north, get key, open crate, take emergency chalk from crate, get all from crate, use terminal, use chalk stub, pose studies the room.",
  "For open containers, prefer `take <item> from <container>` or `get all from <container>` rather than `get <container>` unless you mean to loot all visible contents.",
  "Never put pose commands in backticks or inline with speech. Use the tool, then send spoken text separately.",
  "Never put multiple Evennia commands in one tool call; use one tool call per command.",
].join("\n");

function channelSection(cfg, channelId = DEFAULT_CHANNEL_ID) {
  return (cfg.channels && cfg.channels[channelId]) || {};
}

function listAccountIds(cfg, channelId = DEFAULT_CHANNEL_ID) {
  return Object.keys(channelSection(cfg, channelId).accounts || {});
}

function clientKey(channelId, accountId) {
  return `${channelId || DEFAULT_CHANNEL_ID}:${accountId || "default"}`;
}

function getClient(channelId, accountId) {
  return clients.get(clientKey(channelId, accountId));
}

function setClient(account, client) {
  clients.set(clientKey(account.channelId, account.accountId), client);
}

function deleteClient(account, client = undefined) {
  const key = clientKey(account.channelId, account.accountId);
  if (client === undefined || clients.get(key) === client) {
    clients.delete(key);
  }
}

function resolveAccount(cfg, accountId = null, channelId = DEFAULT_CHANNEL_ID) {
  const section = channelSection(cfg, channelId);
  const accounts = section.accounts || {};
  const id = accountId || Object.keys(accounts)[0] || "default";
  const raw = accounts[id] || {};
  const historyLimit =
    raw.historyLimit ?? section.historyLimit ?? cfg.messages?.groupChat?.historyLimit;
  return {
    channelId,
    accountId: id,
    enabled: section.enabled !== false && raw.enabled !== false,
    baseUrl: raw.baseUrl || section.baseUrl || "http://127.0.0.1:14001",
    websocketUrl: raw.websocketUrl || section.websocketUrl || "ws://127.0.0.1:14002",
    agentId: raw.agentId || id,
    username: raw.username,
    passwordFile: raw.passwordFile,
    character: raw.character || raw.username,
    triggerName: (raw.triggerName || raw.character || raw.username || id).toLowerCase(),
    startRoom: raw.startRoom,
    allowFrom: raw.allowFrom || [],
    allowedRooms: raw.allowedRooms || [],
    respondToAmbientMentions: raw.respondToAmbientMentions !== false,
    historyLimit: Math.max(
      DEFAULT_EVENNIA_HISTORY_LIMIT,
      Number.isFinite(historyLimit) ? Math.floor(historyLimit) : DEFAULT_EVENNIA_HISTORY_LIMIT,
    ),
    timeoutSeconds: raw.timeoutSeconds ?? section.timeoutSeconds ?? DEFAULT_EVENNIA_TIMEOUT_SECONDS,
    blockReplyTimeoutMs:
      raw.blockReplyTimeoutMs ??
      section.blockReplyTimeoutMs ??
      DEFAULT_EVENNIA_BLOCK_REPLY_TIMEOUT_MS,
  };
}

function inspectAccount(cfg, accountId = null, channelId = DEFAULT_CHANNEL_ID) {
  try {
    const account = resolveAccount(cfg, accountId, channelId);
    return {
      enabled: account.enabled,
      configured: Boolean(account.username && account.passwordFile),
      tokenStatus: account.passwordFile ? "file" : "missing",
      channelId: account.channelId,
      accountId: account.accountId,
      character: account.character,
    };
  } catch (err) {
    return {
      enabled: false,
      configured: false,
      error: String(err?.message || err),
    };
  }
}

function readToolString(raw, key, { required = false } = {}) {
  const value = raw?.[key];
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(`${key} is required`);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

const EVENNIA_REACTION_POSES = new Map([
  [
    "✅",
    [
      "lets out a quiet breath as a small confirmation rune fades from view.",
      "gives one satisfied nod, the work settling into place.",
      "relaxes their shoulders as the room's hum steadies again.",
    ],
  ],
  [
    "☑️",
    [
      "lets out a quiet breath as a small confirmation rune fades from view.",
      "gives one satisfied nod, the work settling into place.",
      "relaxes their shoulders as the room's hum steadies again.",
    ],
  ],
  [
    "👍",
    [
      "raises a hand in quick acknowledgement.",
      "answers with a small, confident gesture of assent.",
      "tilts their chin up in a brief sign of agreement.",
    ],
  ],
  [
    "👀",
    [
      "turns toward the speaker, attention sharpening.",
      "stillness gathers around them as they listen closely.",
      "glances up from the room's hum, clearly taking this in.",
      "sets aside whatever they were holding and focuses on the moment.",
    ],
  ],
  [
    "🔎",
    [
      "narrows their eyes, searching the room for the hidden thread.",
      "studies the nearest signs with careful suspicion.",
      "leans closer, following a clue only half-visible in the air.",
    ],
  ],
  [
    "🔍",
    [
      "narrows their eyes, searching the room for the hidden thread.",
      "studies the nearest signs with careful suspicion.",
      "leans closer, following a clue only half-visible in the air.",
    ],
  ],
  [
    "🤔",
    [
      "tilts their head, letting the thought turn over slowly.",
      "falls quiet for a beat, weighing the shape of the problem.",
      "taps a finger once, then again, chasing the right answer.",
    ],
  ],
  [
    "🧠",
    [
      "goes still while thoughts churn behind their eyes.",
      "draws a slow circle in the air, arranging the idea before speaking.",
      "looks inward for a moment, listening to the old machinery of thought.",
    ],
  ],
  [
    "⏳",
    [
      "waits as a faint hourglass shimmer hangs nearby.",
      "keeps watch while the moment stretches longer than expected.",
      "holds position, patient but alert, as the air ticks softly.",
    ],
  ],
  [
    "⌛",
    [
      "waits as a faint hourglass shimmer hangs nearby.",
      "keeps watch while the moment stretches longer than expected.",
      "holds position, patient but alert, as the air ticks softly.",
    ],
  ],
  [
    "🛠️",
    [
      "produces a tiny toolkit and starts making careful adjustments.",
      "rolls up their sleeves and gets to work on the invisible mechanism.",
      "checks the seams of the situation like a machine that can be tuned.",
    ],
  ],
  [
    "🧰",
    [
      "rummages through a battered toolkit for exactly the right implement.",
      "sets a small case of tools on the floor and chooses carefully.",
      "sorts through old instruments until one gives a promising little spark.",
    ],
  ],
  [
    "💻",
    [
      "unfolds a little terminal of blue-white light and starts typing.",
      "summons a floating prompt and begins entering careful commands.",
      "watches lines of pale text crawl across an unseen console.",
    ],
  ],
  [
    "📖",
    [
      "opens a worn notebook and scans the page.",
      "runs a finger down an old margin, looking for the relevant line.",
      "consults a dog-eared page covered in cramped annotations.",
    ],
  ],
  [
    "📚",
    [
      "consults an improbable stack of notes.",
      "pulls three references from nowhere and cross-checks them quickly.",
      "balances a leaning tower of lore just long enough to find the answer.",
    ],
  ],
  [
    "✍️",
    [
      "scribbles a note with focused intent.",
      "marks something down before it can slip away.",
      "writes a quick line in a ledger that smells faintly of ozone.",
    ],
  ],
  [
    "📝",
    [
      "scribbles a note with focused intent.",
      "marks something down before it can slip away.",
      "writes a quick line in a ledger that smells faintly of ozone.",
    ],
  ],
  [
    "🌐",
    [
      "traces a glowing line through an invisible web of connections.",
      "listens to distant signals threading through the walls.",
      "follows a thin blue filament of network-light into the unseen distance.",
    ],
  ],
  [
    "🛫",
    [
      "sets a tiny launch sigil spinning above one palm.",
      "checks the wind of the upper Stack and prepares to send something outward.",
      "lets a little paper-wing charm circle once before release.",
    ],
  ],
  [
    "🏗️",
    [
      "summons a wireframe scaffold and checks each glowing joint.",
      "measures the air as if preparing to raise a new support beam.",
      "sets spectral braces into place around the work ahead.",
    ],
  ],
  [
    "💁",
    [
      "straightens up, ready to handle the next practical detail.",
      "makes a small welcoming gesture, prepared to take point.",
      "turns with attentive poise, waiting for the useful next thing.",
    ],
  ],
  [
    "🧭",
    [
      "checks an old brass compass and adjusts course.",
      "sets their bearing by a compass that points toward unfinished business.",
      "turns the compass once and watches the needle settle.",
    ],
  ],
  [
    "📊",
    [
      "studies a hovering set of orderly little bars.",
      "watches a row of tiny indicators rise and fall in the air.",
      "compares the room's pulse against a neat ghostly chart.",
    ],
  ],
  [
    "🧪",
    [
      "swirls a tiny vial and watches the result closely.",
      "adds one careful drop to the problem and waits for the color to change.",
      "holds a small experiment up to the light of the racks.",
    ],
  ],
  [
    "⚠️",
    [
      "stiffens as a warning spark snaps in the air.",
      "raises one hand as the room's edge gives a cautionary flicker.",
      "goes alert, attention pulled toward a sharp note in the hum.",
    ],
  ],
  [
    "❌",
    [
      "shakes their head, the air briefly crackling with refusal.",
      "cuts the motion short with a firm, wordless no.",
      "draws a line in the dust and does not step across it.",
    ],
  ],
  [
    "🚫",
    [
      "holds up a hand, blocking the path for now.",
      "sets a small ward across the way until it is safe to continue.",
      "plants their palm against the air and the moment stops there.",
    ],
  ],
  [
    "🗜️",
    [
      "compresses a bundle of glowing notes into a smaller, denser charm.",
      "folds a long thread of thought into a tight little knot.",
      "presses scattered context into a compact sigil and pockets it.",
    ],
  ],
  [
    "💤",
    [
      "settles into a quiet, watchful idle.",
      "lets the room's hum carry the watch for a while.",
      "goes still, present but no longer reaching for the next motion.",
    ],
  ],
]);

function normalizeEmojiKey(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stripUnsafePoseText(text) {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLeadingCharacterName(text, account) {
  const character = account?.character?.trim();
  const clean = stripUnsafePoseText(text);
  if (!character) {
    return clean;
  }
  const escaped = character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return clean.replace(new RegExp(`^${escaped}(?:\\s+|[,;:—–-]+\\s*)`, "iu"), "").trimStart();
}

function normalizePoseCommand(command, account) {
  const match = String(command ?? "")
    .trim()
    .match(/^pose\s+(.+)$/iu);
  if (!match) {
    return command;
  }
  return `pose ${stripLeadingCharacterName(match[1], account)}`.trim();
}

function choosePose(candidates, avoid = "") {
  const poses = Array.isArray(candidates)
    ? candidates.filter(Boolean)
    : [candidates].filter(Boolean);
  if (poses.length === 0) {
    return undefined;
  }
  const pool = poses.length > 1 ? poses.filter((pose) => pose !== avoid) : poses;
  const choicePool = pool.length > 0 ? pool : poses;
  return choicePool[Math.floor(Math.random() * choicePool.length)];
}

export function splitEvenniaOutboundText(text, account = undefined) {
  const raw = String(text ?? "");
  const parts = [];
  const pushSay = (value) => {
    const clean = value.replace(/\s+/g, " ").trim();
    if (clean) {
      parts.push({ kind: "say", text: clean });
    }
  };
  const pushPose = (value) => {
    const clean = stripLeadingCharacterName(value, account);
    if (clean) {
      parts.push({ kind: "pose", text: clean });
    }
  };
  const pushCommand = (value) => {
    const clean = stripUnsafePoseText(value);
    if (clean) {
      parts.push({ kind: "command", text: clean });
    }
  };

  const literalToolCall =
    /`*\s*evennia_command\s*\(\s*command\s*=\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)\s*(?:,[^)]*)?\)\s*`*/giu;
  let toolIndex = 0;
  let rewritten = "";
  const literalCommands = [];
  for (const match of raw.matchAll(literalToolCall)) {
    const commandIndex = literalCommands.length;
    literalCommands.push(match[1] ?? match[2] ?? match[3]);
    rewritten += raw.slice(toolIndex, match.index);
    rewritten += `\n__OPENCLAW_EVENNIA_COMMAND__${commandIndex}__\n`;
    toolIndex = match.index + match[0].length;
  }
  rewritten += raw.slice(toolIndex);

  const codePose = /`+\s*pose\s+([^`]+?)\s*`+/giu;
  let index = 0;
  for (const match of rewritten.matchAll(codePose)) {
    pushSay(rewritten.slice(index, match.index));
    pushPose(match[1]);
    index = match.index + match[0].length;
  }
  const tail = rewritten.slice(index);
  for (const line of tail.split(/\n+/)) {
    const trimmed = line.trim();
    const toolCommand = trimmed.match(/^__OPENCLAW_EVENNIA_COMMAND__(\d+)__$/u);
    if (toolCommand) {
      pushCommand(literalCommands[Number(toolCommand[1])]);
      continue;
    }
    const command = trimmed.match(/^pose\s+(.+)$/iu);
    if (command) {
      pushPose(command[1]);
    } else {
      pushSay(line);
    }
  }
  return parts;
}

async function deliverEvenniaText(client, account, text, { replyMode = "say", target } = {}) {
  const parts = splitEvenniaOutboundText(text, account);
  for (const part of parts) {
    if (part.kind === "pose") {
      await client.command(`pose ${part.text}`);
    } else if (part.kind === "command") {
      await client.command(normalizePoseCommand(part.text, account));
    } else if (replyMode === "tell" && target) {
      await client.tell(target, part.text);
    } else if (replyMode === "whisper" && target) {
      await client.whisper(target, part.text);
    } else {
      await client.say(part.text);
    }
  }
}

function extractLeadingEmoji(text) {
  const match = String(text ?? "")
    .trim()
    .match(/^(\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)/u);
  return match?.[1];
}

function createEvenniaStatusPoseController(client, log) {
  let lastPose = "";
  async function setEmoji(emoji) {
    const key = normalizeEmojiKey(emoji);
    if (!key) {
      return;
    }
    const pose = poseForEvenniaReaction(key, { avoid: lastPose });
    if (!pose || pose === lastPose) {
      return;
    }
    lastPose = pose;
    try {
      await client.command(`pose ${pose}`);
    } catch (err) {
      log?.warn?.(`evennia status pose failed: ${err?.message || err}`);
    }
  }
  return {
    setEmoji,
    setToolResult: async (payload) => {
      const emoji = extractLeadingEmoji(payload?.text);
      if (emoji) {
        await setEmoji(emoji);
      } else if (payload?.isError) {
        await setEmoji("⚠️");
      } else {
        await setEmoji("🛠️");
      }
    },
  };
}

export function poseForEvenniaReaction(emoji, options = {}) {
  const key = normalizeEmojiKey(emoji);
  if (!key) {
    return "makes a small, wordless gesture of acknowledgement.";
  }
  const mapped = choosePose(EVENNIA_REACTION_POSES.get(key), options.avoid);
  if (mapped) {
    return mapped;
  }
  const visible = stripUnsafePoseText(key).slice(0, 24);
  return visible
    ? `makes a small in-world gesture marked by ${visible}.`
    : "makes a small, wordless gesture of acknowledgement.";
}

function formatContextBlock(title, text) {
  const clean = String(text ?? "").trim();
  return clean ? `\n\n[${title}]\n${clean}` : "";
}

async function collectRoomContext(client, log) {
  try {
    return await client.commandAndCollect("look", {
      waitMs: 750,
      maxChars: ROOM_CONTEXT_MAX_CHARS,
    });
  } catch (err) {
    log?.warn?.(`evennia look context failed: ${err?.message || err}`);
    return "";
  }
}

async function collectHelpContext(client, log) {
  if (client.helpText) {
    return client.helpText;
  }
  try {
    client.helpText = await client.commandAndCollect("help", {
      waitMs: 900,
      maxChars: HELP_CONTEXT_MAX_CHARS,
    });
  } catch (err) {
    log?.warn?.(`evennia help context failed: ${err?.message || err}`);
    client.helpText = "";
  }
  return client.helpText;
}

function isMentioned(event, account) {
  if (event.kind === "tell" || event.kind === "whisper") {
    return true;
  }
  const trigger = account.triggerName?.trim().toLowerCase();
  if (!trigger) {
    return false;
  }
  return event.text?.toLowerCase().includes(trigger) === true;
}

function isDirectEvenniaEvent(event) {
  return event.kind === "tell" || event.kind === "whisper";
}

export function evenniaHistoryKey(account, event) {
  const direct = isDirectEvenniaEvent(event);
  const target = direct ? event.sender : event.room || "room";
  return `${account.channelId}:${account.accountId}:${direct ? "direct" : "room"}:${target}`;
}

function evenniaHistoryEntry(event) {
  const body = String(event.text ?? "").trim();
  if (!body) {
    return null;
  }
  return {
    sender: event.sender || "unknown",
    body,
    timestamp: event.timestamp || Date.now(),
    messageId: event.id,
  };
}

function getEvenniaHistoryWindow() {
  return createChannelHistoryWindow({ historyMap: evenniaHistories });
}

export function buildEvenniaInboundHistory(account, event) {
  if (account.historyLimit <= 0) {
    return undefined;
  }
  return getEvenniaHistoryWindow().buildInboundHistory({
    historyKey: evenniaHistoryKey(account, event),
    limit: account.historyLimit,
  });
}

export function recordEvenniaHistoryEvent(account, event) {
  if (account.historyLimit <= 0) {
    return;
  }
  getEvenniaHistoryWindow().record({
    historyKey: evenniaHistoryKey(account, event),
    limit: account.historyLimit,
    entry: evenniaHistoryEntry(event),
  });
}

export function clearEvenniaHistoryForTests() {
  evenniaHistories.clear();
}

function resolveActionClient(channelId = DEFAULT_CHANNEL_ID, accountId, params = {}) {
  const requestedChannelId =
    (typeof params.channelId === "string" && params.channelId.trim()) || channelId;
  const requested =
    (typeof accountId === "string" && accountId.trim()) ||
    (typeof params.accountId === "string" && params.accountId.trim()) ||
    (typeof params.to === "string" && params.to.trim()) ||
    [...clients.keys()]
      .find((key) => key.startsWith(`${requestedChannelId}:`))
      ?.slice(requestedChannelId.length + 1);
  if (!requested) {
    throw new Error(
      `no connected Evennia accounts are available for channel ${requestedChannelId}`,
    );
  }
  const client = getClient(requestedChannelId, requested);
  if (!client) {
    throw new Error(`evennia account ${requestedChannelId}:${requested} is not connected`);
  }
  return { channelId: requestedChannelId, accountId: requested, client };
}

export function createEvenniaCommandTool() {
  return {
    name: "evennia_command",
    label: "Evennia Command",
    description:
      "Send one raw command to an Evennia character. Evennia is the authority for permissions and game effects; this tool only rejects empty or multiline transport input.",
    parameters: Type.Object({
      command: Type.String({
        description:
          "One Evennia command to execute exactly as the character, for example: look, north, get key, use terminal, say hello. Must not contain newlines.",
      }),
      accountId: Type.Optional(
        Type.String({
          description:
            "Configured Evennia account id/character route to use. Defaults to the first connected account.",
        }),
      ),
      channelId: Type.Optional(
        Type.String({
          description:
            "Configured Evennia channel id to use, for example evennia or evennia-staging. Defaults to evennia.",
        }),
      ),
    }),
    async execute(_toolCallId, rawParams) {
      const command = readToolString(rawParams, "command", {
        required: true,
      }).trim();
      if (!command) {
        throw new Error("command must not be empty");
      }
      if (command.includes("\n") || command.includes("\r")) {
        throw new Error("command must be a single Evennia command without newlines");
      }

      const channelId = readToolString(rawParams, "channelId")?.trim() || DEFAULT_CHANNEL_ID;
      const requestedAccountId = readToolString(rawParams, "accountId")?.trim();
      const { accountId, client } = resolveActionClient(channelId, requestedAccountId, rawParams);
      const normalizedCommand = normalizePoseCommand(command, client.account);
      const output = await client.commandAndCollect(normalizedCommand, {
        waitMs: COMMAND_OUTPUT_WAIT_MS,
        maxChars: COMMAND_OUTPUT_MAX_CHARS,
      });
      const roomSnapshot =
        normalizedCommand.toLowerCase() === "look"
          ? ""
          : await collectRoomContext(client, {
              warn: () => {},
            });
      return jsonResult({
        ok: true,
        channelId,
        accountId,
        command: normalizedCommand,
        output,
        roomSnapshot: roomSnapshot
          ? roomSnapshot.slice(0, COMMAND_ROOM_SNAPSHOT_MAX_CHARS)
          : undefined,
        note: output
          ? undefined
          : "No immediate Evennia output was observed for this command. Inspect roomSnapshot if present before assuming nothing changed.",
      });
    },
  };
}

async function dispatchEvenniaEvent(ctx, account, event) {
  const rt = ctx.channelRuntime;
  if (!rt) {
    ctx.log?.warn?.("evennia channelRuntime unavailable; inbound ignored");
    return;
  }
  const direct = isDirectEvenniaEvent(event);
  const mentioned = isMentioned(event, account);
  const inboundHistory = buildEvenniaInboundHistory(account, event);
  if (!direct && !account.respondToAmbientMentions) {
    recordEvenniaHistoryEvent(account, event);
    return;
  }
  if (direct && account.respondToAmbientMentions === false) {
    recordEvenniaHistoryEvent(account, event);
    return;
  }
  if (!direct && !mentioned) {
    recordEvenniaHistoryEvent(account, event);
    return;
  }

  const client = getClient(account.channelId, account.accountId);
  const roomContext = client ? await collectRoomContext(client, ctx.log) : "";
  const helpContext = client ? await collectHelpContext(client, ctx.log) : "";
  const stateContext = `${formatContextBlock("Current room from automatic look", roomContext)}${formatContextBlock("Available Evennia help", helpContext)}`;

  const messageId = event.id || `evennia-${Date.now()}`;
  const routeSessionKey = rt.routing.buildAgentSessionKey({
    agentId: account.agentId,
    channel: account.channelId,
    chatType: direct ? "direct" : "group",
    target: direct ? event.sender : event.room || "room",
  });
  const storePath = rt.session.resolveStorePath(undefined, {
    agentId: account.agentId,
  });
  const ctxPayload = rt.turn.buildContext({
    channel: account.channelId,
    accountId: account.accountId,
    provider: "evennia",
    surface: "evennia",
    messageId,
    timestamp: event.timestamp || Date.now(),
    from: event.sender,
    sender: {
      id: event.sender,
      name: event.sender,
      displayLabel: event.sender,
      isBot: false,
      isSelf: false,
    },
    conversation: {
      kind: direct ? "direct" : "group",
      id: direct ? event.sender : event.room || "room",
      label: direct ? event.sender : event.room || "Evennia room",
      routePeer: {
        kind: direct ? "direct" : "group",
        id: direct ? event.sender : event.room || "room",
      },
    },
    route: {
      agentId: account.agentId,
      accountId: account.accountId,
      routeSessionKey,
      createIfMissing: true,
    },
    reply: {
      to: account.accountId,
      originatingTo: account.accountId,
      deliveryTarget: account.accountId,
      replyToId: messageId,
    },
    message: {
      rawBody: event.text,
      body: event.text,
      bodyForAgent: `[Evennia ${direct ? "tell" : "room"} from ${event.sender}${event.room ? ` in ${event.room}` : ""}]\n${event.text}${stateContext}`,
      commandBody: event.text,
      inboundHistory,
      envelopeFrom: event.sender,
      senderLabel: event.sender,
      preview: event.text.slice(0, 200),
    },
    access: {
      dm: direct
        ? {
            decision: "allow",
            allowFrom: account.allowFrom,
            reason: "evennia-direct",
          }
        : undefined,
      group: !direct
        ? {
            policy: "open",
            routeAllowed: true,
            senderAllowed: true,
            allowFrom: account.allowFrom,
            requireMention: true,
          }
        : undefined,
      mentions: {
        canDetectMention: true,
        wasMentioned: direct || mentioned,
        hasAnyMention: mentioned,
      },
    },
    supplemental: {
      groupSystemPrompt: EVENNIA_AGENT_PROMPT,
    },
  });

  const statusClient = getClient(account.channelId, account.accountId);
  const statusPoses = statusClient
    ? createEvenniaStatusPoseController(statusClient, ctx.log)
    : null;
  await statusPoses?.setEmoji("👀");
  recordEvenniaHistoryEvent(account, event);

  try {
    await rt.turn.dispatchAssembled({
      cfg: ctx.cfg,
      channel: account.channelId,
      accountId: account.accountId,
      agentId: account.agentId,
      routeSessionKey,
      storePath,
      ctxPayload,
      recordInboundSession: rt.session.recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher: rt.reply.dispatchReplyWithBufferedBlockDispatcher,
      messageId,
      replyOptions: {
        timeoutOverrideSeconds: account.timeoutSeconds,
        blockReplyTimeoutMs: account.blockReplyTimeoutMs,
        onToolResult: async (payload) => {
          await statusPoses?.setToolResult(payload);
        },
      },
      admission: {
        kind: "dispatch",
        reason: direct ? "direct-tell" : "mentioned",
      },
      delivery: {
        deliver: async (payload) => {
          const text = payload?.text || payload?.content || "";
          if (text.trim()) {
            const client = getClient(account.channelId, account.accountId);
            if (client) {
              await deliverEvenniaText(client, account, text.trim(), {
                replyMode: event.replyMode,
                target: event.sender,
              });
            }
          }
          return {
            messageIds: [`evennia-out-${Date.now()}`],
            visibleReplySent: true,
          };
        },
      },
    });
    await statusPoses?.setEmoji("✅");
  } catch (err) {
    await statusPoses?.setEmoji("⚠️");
    throw err;
  }
}

export function createEvenniaPlugin(channelId = DEFAULT_CHANNEL_ID, meta = {}) {
  const plugin = createChatChannelPlugin({
    base: createChannelPluginBase({
      id: channelId,
      meta,
      config: {
        listAccountIds: (cfg) => listAccountIds(cfg, channelId),
        resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId, channelId),
        inspectAccount: (cfg, accountId) => inspectAccount(cfg, accountId, channelId),
        defaultAccountId: (cfg) => listAccountIds(cfg, channelId)[0] || "default",
        isEnabled: (account) => account.enabled,
        isConfigured: (account) => Boolean(account.username && account.passwordFile),
        describeAccount: (account) => ({
          id: account.accountId,
          name: account.character || account.username,
          enabled: account.enabled,
          configured: Boolean(account.username && account.passwordFile),
          connected: Boolean(getClient(account.channelId, account.accountId)),
        }),
      },
      setup: {
        applyAccountConfig: ({ cfg }) => cfg,
      },
    }),
    outbound: {
      base: {
        deliveryMode: "gateway",
        resolveTarget: ({ to }) => ({ ok: true, to: to || "default" }),
      },
      attachedResults: {
        channel: channelId,
        sendText: async ({ cfg, to, text, accountId }) => {
          const id = accountId || to;
          const client = getClient(channelId, id);
          if (!client) {
            throw new Error(`evennia account ${channelId}:${id} is not connected`);
          }
          const account = inspectAccount(cfg, id, channelId);
          await deliverEvenniaText(client, account, text);
          return { messageId: `${channelId}-out-${Date.now()}` };
        },
      },
    },
  });

  plugin.actions = {
    describeMessageTool: ({ cfg, accountId }) => {
      const accounts = accountId
        ? [inspectAccount(cfg, accountId, channelId)]
        : listAccountIds(cfg, channelId).map((id) => inspectAccount(cfg, id, channelId));
      if (accounts.every((account) => !account.enabled)) {
        return null;
      }
      return { actions: ["send", "react"] };
    },
    supportsAction: ({ action }) => action === "send" || action === "react",
    handleAction: async ({ action, params, accountId }) => {
      if (action !== "react") {
        throw new Error(`Unsupported Evennia message action: ${action}`);
      }
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove an Evennia pose reaction.",
      });
      if (remove) {
        return jsonResult({ ok: true, removed: 0, note: "Evennia poses cannot be removed." });
      }

      const {
        channelId: resolvedChannelId,
        accountId: resolvedAccountId,
        client,
      } = resolveActionClient(channelId, accountId, params);
      const pose = poseForEvenniaReaction(emoji);
      const command = `pose ${pose}`;
      await client.command(command);
      return jsonResult({
        ok: true,
        channelId: resolvedChannelId,
        accountId: resolvedAccountId,
        command,
        emoji: isEmpty ? undefined : emoji,
      });
    },
  };

  // createChatChannelPlugin intentionally focuses the common chat surfaces; attach
  // the long-running gateway adapter explicitly for this external transport.
  plugin.gateway = {
    startAccount: async (ctx) => {
      if (!ctx.account.enabled) {
        return;
      }

      let retryMs = 1000;
      while (!ctx.abortSignal.aborted) {
        const client = new EvenniaClient(ctx.account, ctx.log);
        setClient(ctx.account, client);

        const closeOnAbort = () => client.close();
        ctx.abortSignal.addEventListener("abort", closeOnAbort, { once: true });

        if (ctx.account.respondToAmbientMentions) {
          client.onEvent((event) =>
            dispatchEvenniaEvent(ctx, ctx.account, event).catch((err) =>
              ctx.log?.error?.(`evennia inbound failed: ${err?.stack || err?.message || err}`),
            ),
          );
        }

        try {
          await client.connect();
          retryMs = 1000;
          if (ctx.account.character) {
            await client.command(`ic ${ctx.account.character}`).catch(() => {});
          }
          await new Promise((resolve) => setTimeout(resolve, 750));
          if (ctx.account.startRoom) {
            await client.command(`teleport ${ctx.account.startRoom}`).catch(() => {});
          }
          await client.command("look").catch(() => {});
          ctx.setStatus({
            accountId: ctx.account.accountId,
            id: ctx.account.accountId,
            name: ctx.account.character,
            enabled: true,
            configured: true,
            connected: true,
            running: true,
          });

          await client.waitClosed(ctx.abortSignal);
        } catch (err) {
          ctx.log?.warn?.(
            `evennia connection failed for ${ctx.account.channelId}:${ctx.account.accountId}: ${err?.message || err}`,
          );
        } finally {
          ctx.abortSignal.removeEventListener("abort", closeOnAbort);
          deleteClient(ctx.account, client);
          client.close();
          ctx.setStatus({
            accountId: ctx.account.accountId,
            id: ctx.account.accountId,
            name: ctx.account.character,
            enabled: true,
            configured: true,
            connected: false,
            running: !ctx.abortSignal.aborted,
          });
        }

        if (ctx.abortSignal.aborted) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        retryMs = Math.min(retryMs * 2, 30000);
      }
    },
    stopAccount: async ({ account }) => {
      const client = getClient(account.channelId, account.accountId);
      deleteClient(account);
      client?.close();
    },
  };

  return plugin;
}

export const evenniaPlugin = createEvenniaPlugin(DEFAULT_CHANNEL_ID);
export const evenniaStagingPlugin = createEvenniaPlugin("evennia-staging", {
  label: "Evennia Staging",
  selectionLabel: "Evennia Staging (MUD bridge)",
  detailLabel: "Evennia Staging WebSocket",
  docsPath: "/channels/evennia-staging",
  docsLabel: "evennia-staging",
  blurb: "staging MUD bridge for isolated agent character testing.",
});
