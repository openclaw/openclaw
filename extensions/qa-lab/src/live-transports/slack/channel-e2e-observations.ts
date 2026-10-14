import { z } from "zod";
import type {
  QaChannelE2eDriver,
  QaChannelE2eMessage,
  QaChannelE2eDoctorResult,
} from "../shared/channel-e2e.types.js";
import {
  slackHistorySchema,
  type SlackAuthIdentity,
  type SlackMessage,
  type SlackQaWebClient,
} from "./slack-live.contracts.js";

// SDK errors can contain headers/tokens. Keep only Slack's error code and required scopes.
export function sanitizeSlackFailure(
  error: unknown,
  context?: { operation: string; detail?: string },
): Error {
  const result = z
    .object({
      data: z.object({ error: z.string(), needed: z.string().optional() }).optional(),
    })
    .safeParse(error);
  const code = result.success ? result.data.data?.error : undefined;
  const needed = result.success ? result.data.data?.needed : undefined;
  const cause =
    code && /^[a-zA-Z0-9_]+$/u.test(code)
      ? `${code}${needed && /^[a-zA-Z0-9_:, .-]+$/u.test(needed) ? `; needed=${needed}` : ""}`
      : "request failed without a definitive Slack receipt; inspect private Gateway evidence";
  return new Error(context ? `Slack ${context.operation}: ${context.detail ?? cause}` : cause, {
    cause,
  });
}

export function createSlackE2eObservations(params: {
  channelId: string;
  driverIdentity: SlackAuthIdentity;
  sutIdentity: SlackAuthIdentity;
  driverClient: SlackQaWebClient;
  sutClient: SlackQaWebClient;
  assertActive: () => void;
  waitReady: () => Promise<void>;
}) {
  let ready: Promise<void> | undefined;
  let driverScopes: string[] | undefined;
  let sutScopes: string[] | undefined;
  const checked = async <T>(operation: string, action: () => Promise<T>): Promise<T> => {
    params.assertActive();
    let result: T;
    try {
      result = await action();
    } catch (error) {
      params.assertActive();
      throw sanitizeSlackFailure(error, { operation });
    }
    params.assertActive();
    return result;
  };
  const ensureReady = async () => {
    params.assertActive();
    ready ??= (async () => {
      const driver = await checked("driver auth.test", () => params.driverClient.auth.test());
      const sut = await checked("SUT auth.test", () => params.sutClient.auth.test());
      if (
        driver.user_id !== params.driverIdentity.userId ||
        sut.user_id !== params.sutIdentity.userId ||
        !driver.team_id ||
        driver.team_id !== sut.team_id ||
        driver.user_id === sut.user_id
      ) {
        throw new Error("Slack leased driver/SUT identity or workspace mismatch");
      }
      driverScopes = driver.response_metadata?.scopes;
      sutScopes = sut.response_metadata?.scopes;
      // History checks both actors' channel access without requiring extra conversations.info scopes.
      for (const [actor, client] of [
        ["driver", params.driverClient],
        ["SUT", params.sutClient],
      ] as const) {
        await checked(`${actor} conversations.history (channel membership/history scope)`, () =>
          client.conversations.history({ channel: params.channelId, limit: 1 }),
        );
      }
      await checked("Gateway connected readiness", params.waitReady);
    })();
    await ready;
    params.assertActive();
  };
  const assertScopes = (actor: "driver" | "sut", required: readonly string[]) => {
    params.assertActive();
    const advertised = actor === "driver" ? driverScopes : sutScopes;
    const missing = required.filter((scope) => advertised && !advertised.includes(scope));
    if (missing.length) {
      throw new Error(`Slack ${actor} missing_scope; needed=${missing.join(", ")}`);
    }
  };
  const doctor = async (): Promise<QaChannelE2eDoctorResult> => {
    await ensureReady();
    const missingScopes = [
      ...["chat:write", "reactions:read", "reactions:write", "files:read", "files:write"]
        .filter((scope) => driverScopes && !driverScopes.includes(scope))
        .map((scope) => `driver ${scope}`),
      ...["chat:write", "files:read"]
        .filter((scope) => sutScopes && !sutScopes.includes(scope))
        .map((scope) => `SUT ${scope}`),
    ];
    return {
      ok: missingScopes.length === 0,
      checks: [
        { name: "leased identities and workspace", ok: true },
        { name: "both bots can read leased channel", ok: true },
        { name: "owned Gateway Slack connection", ok: true },
        {
          name: "advertised lifecycle scopes",
          ok: missingScopes.length === 0,
          detail: missingScopes.length
            ? `Missing: ${missingScopes.join(", ")}`
            : !driverScopes || !sutScopes
              ? "Slack did not advertise all scopes; mutation permissions remain unproven until exercised"
              : "Advertised scopes present; mutations still require successful native receipts",
        },
      ],
      capabilities: {
        automated: [
          "mention/quiet ingress",
          "stored message pagination",
          "owned edits/deletes",
          "scoped thread replies",
          "correlated SUT reply waits",
          "reactions (requires reactions:read/write)",
          "upload/readback (requires files:read/write)",
        ],
        observationOnly: [
          "Gateway debug-proxy accepted writes",
          "stored Block Kit/reaction/file state",
        ],
        manualClient: [
          "human slash invocation",
          "real button clicks",
          "Agent View",
          "visual rendering",
          "human typing indicators",
        ],
        unavailable: [
          ...missingScopes.map((scope) => ({
            capability: scope,
            reason:
              "Missing from the leased app's advertised OAuth scopes; ask the pool owner, do not grant scopes from QA",
          })),
          {
            capability: "bot visual/typing proof",
            reason:
              "Web API receipts and stored state do not prove client rendering or human interaction",
          },
        ],
      },
    };
  };
  const toMessage = (message: SlackMessage): QaChannelE2eMessage => {
    if (!message.ts) {
      throw new Error("Slack stored message has no timestamp");
    }
    return {
      id: message.ts,
      channelId: params.channelId,
      threadId: message.thread_ts,
      text: message.text ?? "",
      actor:
        message.user === params.driverIdentity.userId
          ? "driver"
          : message.user === params.sutIdentity.userId ||
              (message.bot_id && message.bot_id === params.sutIdentity.botId)
            ? "sut"
            : "other",
      attachments: message.files?.map((file) => ({
        id: file.id,
        name: file.name,
        contentType: file.mimetype,
      })),
    };
  };
  const readNative = async (input: Parameters<QaChannelE2eDriver["read"]>[0] = {}) => {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("Slack read limit must be an integer between 1 and 1000");
    }
    const messages: QaChannelE2eMessage[] = [];
    let cursor: string | undefined;
    do {
      const args = {
        channel: params.channelId,
        oldest: input.messageId ?? input.after,
        latest: input.messageId ?? input.before,
        inclusive: Boolean(input.messageId),
        limit: Math.min(limit - messages.length, 100),
        cursor,
      };
      const response = await checked("stored read", async () =>
        input.threadId
          ? await params.sutClient.conversations.replies({ ...args, ts: input.threadId })
          : await params.sutClient.conversations.history(args),
      );
      const page = slackHistorySchema.parse(response);
      messages.push(
        ...(page.messages ?? [])
          .filter((message) => !input.messageId || message.ts === input.messageId)
          .map(toMessage),
      );
      const next = page.response_metadata?.next_cursor?.trim();
      if (next && next === cursor) {
        throw new Error("Slack history repeated its pagination cursor");
      }
      cursor = next;
    } while (cursor && messages.length < limit);
    return messages;
  };
  return { checked, ensureReady, assertScopes, doctor, readNative };
}
