import {
  asMeetingBrowserTabs,
  resolveLocalMeetingBrowserRequest,
  runMeetingBrowserAct,
  type MeetingBrowserRequestCaller,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { z } from "zod";
import type { GoogleMeetConfig } from "../config.js";
import type { GoogleMeetChatSnapshot } from "../google-meet-chat.js";
import { chromeNodeBrowserRequest } from "./chrome-browser-proxy.js";
import { meetReadChatScript } from "./google-meet-chat-scripts.js";
import { isSameMeetUrlForReuse } from "./google-meet-urls.js";
import type { GoogleMeetSession } from "./types.js";

const chatSourceSchema = z.object({
  kind: z.literal("chat"),
  id: z
    .string()
    .min(1)
    .max(512)
    .regex(/^spaces\/[^/]+\/messages\/[^/]+$/),
  epoch: z
    .string()
    .min(1)
    .max(256)
    .refine((value) => value.trim().length > 0),
  revision: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => value.trim().length > 0),
  text: z.string().max(16_384),
  ownEcho: z.boolean().optional(),
  finalized: z.boolean(),
  historical: z.boolean(),
  speaker: z.string().max(512).optional(),
  at: z.string().max(128).optional(),
});

const chatReadSchema = z.object({
  status: z.literal("succeeded"),
  epoch: z
    .string()
    .min(1)
    .max(256)
    .refine((value) => value.trim().length > 0),
  sources: z.array(chatSourceSchema).max(256),
  unrecognizedRows: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

function parseGoogleMeetChatRead(result: unknown): GoogleMeetChatSnapshot {
  const invalid = () => new Error("Meet returned an invalid native chat snapshot.");
  // The bound accommodates the source limit even when JSON escapes every character.
  const wire = z.object({ result: z.string().max(32 * 1024 * 1024) }).safeParse(result);
  if (!wire.success) {
    throw invalid();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(wire.data.result);
  } catch {
    throw invalid();
  }
  const parsed = chatReadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw invalid();
  }
  const { epoch, sources } = parsed.data;
  const identities = new Set<string>();
  for (const source of sources) {
    if (
      source.epoch !== epoch ||
      identities.has(source.id) ||
      (!source.historical &&
        (!/\/messages\/[0-9]{16}$/.test(source.id) ||
          !Number.isSafeInteger(Number(source.id.split("/").at(-1))))) ||
      (source.finalized && (source.ownEcho === undefined || !source.text.trim()))
    ) {
      throw invalid();
    }
    identities.add(source.id);
  }
  return { epoch, sources };
}

export async function readChromeMeetChat(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  session: GoogleMeetSession;
  assertCurrent?: () => void;
}): Promise<GoogleMeetChatSnapshot> {
  const { session } = params;
  const transport = session.transport;
  const targetId = session.chrome?.browserTab?.targetId;
  const nodeId = session.chrome?.nodeId;
  const meetingSessionId = session.id;
  const meetingUrl = session.url;
  if ((transport !== "chrome" && transport !== "chrome-node") || !targetId?.trim()) {
    throw new Error("Meet chat requires a tracked browser meeting tab.");
  }
  const assertCurrent = () => {
    params.assertCurrent?.();
    if (
      session.state !== "active" ||
      session.browserLeft ||
      session.id !== meetingSessionId ||
      session.url !== meetingUrl ||
      session.transport !== transport ||
      session.chrome?.browserTab?.targetId !== targetId ||
      session.chrome?.nodeId !== nodeId
    ) {
      throw new Error("The tracked meeting changed before chat capture completed.");
    }
  };
  const deadline =
    performance.now() + Math.min(Math.max(1_000, params.config.chrome.joinTimeoutMs), 10_000);
  assertCurrent();
  let callBrowser: MeetingBrowserRequestCaller;
  if (transport === "chrome-node") {
    // Resolve only the stored session pin; do not discover another node or fall back locally.
    if (!nodeId?.trim()) {
      throw new Error("The meeting has no pinned browser node for chat capture.");
    }
    callBrowser = chromeNodeBrowserRequest(params.runtime, nodeId);
  } else {
    callBrowser = await resolveLocalMeetingBrowserRequest(params.runtime);
  }
  assertCurrent();
  const inventoryTimeoutMs = Math.floor(deadline - performance.now());
  if (inventoryTimeoutMs <= 0) {
    throw new Error("Meet chat capture timed out before reading the tracked tab.");
  }
  // Inventory does not mutate the tab and must not hold up realtime audio pulls.
  const tabs = asMeetingBrowserTabs(
    await callBrowser({ method: "GET", path: "/tabs", timeoutMs: inventoryTimeoutMs }),
  );
  assertCurrent();
  const matches = tabs.filter((tab) => tab?.targetId === targetId);
  const tab = matches.length === 1 ? matches[0] : undefined;
  if (!tab || !isSameMeetUrlForReuse(tab.url, meetingUrl)) {
    throw new Error("The tracked browser tab no longer shows this meeting.");
  }
  const result = await runMeetingBrowserAct({
    // Optional polling leaves headroom inside audio capture's five-second control budget.
    deadline: Math.min(deadline, performance.now() + 1_000),
    targetId,
    operation: async (timeoutMs) => {
      assertCurrent();
      // The page script rechecks the session marker and URL after lock acquisition.
      const evaluated = await callBrowser({
        method: "POST",
        path: "/act",
        body: {
          kind: "evaluate",
          targetId,
          fn: meetReadChatScript({ meetingSessionId, meetingUrl }),
        },
        timeoutMs,
      });
      assertCurrent();
      return parseGoogleMeetChatRead(evaluated);
    },
  });
  assertCurrent();
  return result;
}
