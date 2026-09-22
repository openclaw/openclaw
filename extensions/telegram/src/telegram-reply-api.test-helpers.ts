import { Bot } from "grammy";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";

export type TelegramReplyApiCall = {
  method: string;
  fields: Record<string, unknown>;
  files: Array<{ name: string; content: Buffer }>;
};

export function telegramReplyTarget(call: TelegramReplyApiCall): unknown {
  return (
    asOptionalRecord(call.fields.reply_parameters)?.message_id ??
    call.fields.reply_to_message_id ??
    null
  );
}

export async function withTelegramReplyApi(
  run: (fixture: { bot: Bot; calls: TelegramReplyApiCall[] }) => Promise<void>,
  reject?: (call: TelegramReplyApiCall) => { error_code: number; description: string } | undefined,
): Promise<void> {
  const calls: TelegramReplyApiCall[] = [];
  let nextMessageId = 1000;
  await withServer(
    (request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks);
        const contentType = request.headers["content-type"] ?? "application/json";
        let fields: Record<string, unknown>;
        const files: TelegramReplyApiCall["files"] = [];
        if (contentType.includes("application/json")) {
          const parsed = asOptionalRecord(JSON.parse(body.toString("utf8")));
          if (!parsed) {
            throw new Error("Missing Telegram request body");
          }
          fields = parsed;
        } else {
          const form = await new Response(new Uint8Array(body), {
            headers: { "content-type": contentType },
          }).formData();
          fields = {};
          for (const [key, value] of form) {
            if (typeof value !== "string") {
              files.push({ name: value.name, content: Buffer.from(await value.arrayBuffer()) });
            } else if (["reply_parameters", "reply_markup"].includes(key)) {
              fields[key] = JSON.parse(value);
            } else if (
              [
                "chat_id",
                "message_id",
                "message_thread_id",
                "direct_messages_topic_id",
                "reply_to_message_id",
              ].includes(key)
            ) {
              fields[key] = Number(value);
            } else {
              fields[key] = value;
            }
          }
        }
        const method = request.url?.split("/").at(-1) ?? "";
        const call = { method, fields, files };
        calls.push(call);
        response.setHeader("content-type", "application/json");
        const failure = reject?.(call);
        if (failure) {
          response.writeHead(failure.error_code).end(JSON.stringify({ ok: false, ...failure }));
          return;
        }
        response.end(
          JSON.stringify({
            ok: true,
            result: {
              message_id: ++nextMessageId,
              date: 1,
              chat: { id: 123, type: "private" },
              ...(typeof fields.message_thread_id === "number"
                ? { message_thread_id: fields.message_thread_id }
                : {}),
              ...(typeof fields.direct_messages_topic_id === "number"
                ? { direct_messages_topic: { topic_id: fields.direct_messages_topic_id } }
                : {}),
              text: fields.text ?? "",
              ...(method === "sendDocument"
                ? {
                    document: {
                      file_id: "synthetic-document",
                      file_unique_id: String(nextMessageId),
                      file_name: files[0]?.name ?? "document.txt",
                      mime_type: "text/plain",
                    },
                  }
                : {}),
            },
          }),
        );
      })().catch((error: unknown) => {
        response.writeHead(500).end(String(error));
      });
    },
    async (apiRoot) => {
      await run({ bot: new Bot("123456:synthetic_test_token", { client: { apiRoot } }), calls });
    },
  );
}
