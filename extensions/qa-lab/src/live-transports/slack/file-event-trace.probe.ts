// Temporary QA probe captures a redacted real Slack file-upload event sequence.
import { createHash, publicEncrypt } from "node:crypto";
import { App, LogLevel } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "../shared/credential-lease.runtime.js";

type SlackQaCredential = {
  channelId: string;
  driverBotToken: string;
  sutBotToken: string;
  sutAppToken: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseCredential(value: unknown): SlackQaCredential {
  const record = asRecord(value);
  const keys = ["channelId", "driverBotToken", "sutBotToken", "sutAppToken"] as const;
  if (!record || keys.some((key) => typeof record[key] !== "string" || !record[key])) {
    throw new Error("Slack QA credential payload has the wrong shape");
  }
  return Object.fromEntries(keys.map((key) => [key, record[key]])) as SlackQaCredential;
}

function resolveEnvCredential(): SlackQaCredential {
  return parseCredential({
    channelId: process.env.OPENCLAW_QA_SLACK_CHANNEL_ID,
    driverBotToken: process.env.OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN,
    sutBotToken: process.env.OPENCLAW_QA_SLACK_SUT_BOT_TOKEN,
    sutAppToken: process.env.OPENCLAW_QA_SLACK_SUT_APP_TOKEN,
  });
}

const fileAliases = new Map<string, string>();
const timeAliases = new Map<string, string>();

function alias(value: unknown, aliases: Map<string, string>, prefix: string): string | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const existing = aliases.get(value);
  if (existing) {
    return existing;
  }
  const next = `${prefix}${aliases.size + 1}`;
  aliases.set(value, next);
  return next;
}

function summarizeFiles(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const file = asRecord(entry) ?? {};
    return {
      id: alias(file.id, fileAliases, "F"),
      mode: typeof file.mode === "string" ? file.mode : null,
      fileAccess: typeof file.file_access === "string" ? file.file_access : null,
      hasPrivateUrl: Boolean(file.url_private || file.url_private_download),
    };
  });
}

function summarizeMessage(value: unknown) {
  const message = asRecord(value);
  if (!message) {
    return null;
  }
  return {
    type: typeof message.type === "string" ? message.type : null,
    subtype: typeof message.subtype === "string" ? message.subtype : null,
    hidden: message.hidden === true,
    ts: alias(message.ts, timeAliases, "TS"),
    eventTs: alias(message.event_ts, timeAliases, "EVT"),
    hasUser: typeof message.user === "string",
    hasBotId: typeof message.bot_id === "string",
    fileCount: Array.isArray(message.files) ? message.files.length : 0,
    files: summarizeFiles(message.files),
  };
}

function isFileEvent(event?: Record<string, unknown>, nested?: Record<string, unknown>) {
  return (
    event?.subtype === "file_share" ||
    nested?.subtype === "file_share" ||
    Array.isArray(event?.files) ||
    Array.isArray(nested?.files)
  );
}

function safeError(error: unknown) {
  const record = asRecord(error);
  const data = asRecord(record?.data);
  const code = data?.error ?? record?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.name : "unknown";
}

const traceMode = process.env.OPENCLAW_QA_FILE_TRACE_MODE === "browser" ? "browser" : "api";
const marker =
  traceMode === "browser"
    ? `OPENCLAW_QA_BROWSER_FILE_FINALIZATION_${process.env.GITHUB_RUN_ID ?? Date.now()}`
    : `OPENCLAW_QA_FILE_FINALIZATION_${Date.now()}`;
const locatorPublicKey = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnvIMGBJwjC3rt9eT9m9b
VPUMkjKB8ww/EydbxUmPr6e4+y0/PM6AC5ZMyGXg4V41pJTNAJO/oBkf8zb7l1FJ
KrkJ/pca7TIJBYWd18Joi0LAdQt124njFxZylNi1lR2VVos+o6JOUnwAzhnf4fTw
8YOw5FuRwOzHMjDdkFvR996vdCJs4746ITdXWrIwtQGDkxQ3wHHQmeA/bkVWlBdp
dP+WU8POgGauOGaAMhCh7BOwZ6K47MeHPTQPwpfiQ1+ir1KR7G8jX7DuwViThzVy
6yIZqfGr0GU7Y0188DZ/VkLLQzYKi5nmVn0GLjWi11a5j++rPLq065GQQFloYGm/
5wIDAQAB
-----END PUBLIC KEY-----`;
const trace: Array<Record<string, unknown>> = [];
let lastEventAt = 0;
let lease: Awaited<ReturnType<typeof acquireQaCredentialLease<SlackQaCredential>>> | undefined;
let heartbeat: ReturnType<typeof startQaCredentialLeaseHeartbeat> | undefined;
let app: App | undefined;
let uploadedFileIds: string[] = [];
let locatorMessageTs: string | undefined;
let targetChannelId: string | undefined;

try {
  lease = await acquireQaCredentialLease({
    kind: "slack",
    source: "convex",
    role: "ci",
    parsePayload: parseCredential,
    resolveEnvPayload: resolveEnvCredential,
  });
  heartbeat = startQaCredentialLeaseHeartbeat(lease);
  const credential = lease.payload;
  targetChannelId = credential.channelId;
  app = new App({
    token: credential.sutBotToken,
    appToken: credential.sutAppToken,
    socketMode: true,
    ignoreSelf: false,
    logLevel: LogLevel.ERROR,
  });
  app.use(async ({ body, next }) => {
    const event = asRecord(asRecord(body)?.event);
    const nested = asRecord(event?.message);
    const eventText = typeof event?.text === "string" ? event.text : "";
    const nestedText = typeof nested?.text === "string" ? nested.text : "";
    const matchesApiUpload = eventText.includes(marker) || nestedText.includes(marker);
    const matchesBrowserUpload = event?.channel === targetChannelId && isFileEvent(event, nested);
    if (
      event?.type === "message" &&
      (traceMode === "browser" ? matchesBrowserUpload : matchesApiUpload)
    ) {
      trace.push({
        sequence: trace.length + 1,
        outer: summarizeMessage(event),
        message: summarizeMessage(event.message),
        previousMessage: summarizeMessage(event.previous_message),
      });
      lastEventAt = Date.now();
    }
    await next();
  });
  app.event("message", async () => {});
  await app.start();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 2_000);
  });

  const web = new WebClient(credential.sutBotToken);
  const auth = await web.auth.test();
  const teamIdHash = createHash("sha256")
    .update(auth.team_id ?? "")
    .digest("hex");
  const encryptedWorkspaceLocator = publicEncrypt(
    { key: locatorPublicKey, oaepHash: "sha256" },
    Buffer.from(JSON.stringify({ team: auth.team ?? null, url: auth.url ?? null })),
  ).toString("base64");
  if (traceMode === "browser") {
    const locator = await web.apiCall("chat.postMessage", {
      channel: credential.channelId,
      text: marker,
    });
    const locatorRecord = asRecord(locator);
    locatorMessageTs = typeof locatorRecord?.ts === "string" ? locatorRecord.ts : undefined;
    process.stderr.write(`Slack browser trace ready: ${marker}\n`);
  } else {
    const upload = (await web.filesUploadV2({
      channel_id: credential.channelId,
      initial_comment: marker,
      file_uploads: [
        { content: "alpha\n", filename: "qa-finalization-a.txt" },
        { content: "beta\n", filename: "qa-finalization-b.txt" },
      ],
    })) as { files?: Array<{ id?: string }> };
    uploadedFileIds = (upload.files ?? []).flatMap((file) => (file.id ? [file.id] : []));
  }

  const waitStartedAt = Date.now();
  const waitTimeoutMs = traceMode === "browser" ? 8 * 60_000 : 20_000;
  const quietPeriodMs = traceMode === "browser" ? 8_000 : 4_000;
  while (Date.now() - waitStartedAt < waitTimeoutMs) {
    if (trace.length > 0 && Date.now() - lastEventAt >= quietPeriodMs) {
      break;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        source: "real Slack Socket Mode event stream",
        teamIdHash,
        encryptedWorkspaceLocator,
        uploadMethod: traceMode === "browser" ? "Slack web client" : "WebClient.filesUploadV2",
        fileUploadCount: traceMode === "browser" ? null : 2,
        eventCount: trace.length,
        trace,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: safeError(error) })}\n`);
  process.exitCode = 1;
} finally {
  if (lease) {
    const web = new WebClient(lease.payload.sutBotToken);
    await Promise.allSettled([
      ...uploadedFileIds.map(async (file) => await web.files.delete({ file })),
      ...(locatorMessageTs
        ? [web.chat.delete({ channel: lease.payload.channelId, ts: locatorMessageTs })]
        : []),
    ]);
  }
  await app?.stop().catch(() => {});
  await heartbeat?.stop().catch(() => {});
  await lease?.release().catch(() => {});
}
