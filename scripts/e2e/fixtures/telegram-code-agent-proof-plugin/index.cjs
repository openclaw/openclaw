module.exports = {
  id: "telegram-code-agent-proof",
  name: "Telegram Code Agent Proof",
  description: "E2E fixture for Telegram code-agent callback routing proof.",
  register(api) {
    api.registerInteractiveHandler({
      channel: "telegram",
      namespace: "code-agent",
      handler: async (ctx) => {
        const fs = require("node:fs");
        const path = require("node:path");
        const markerDir = path.dirname(process.env.OPENCLAW_CONFIG_PATH || "/tmp/openclaw-proof");
        const markerPath = path.join(markerDir, "telegram-code-agent-proof-handler.jsonl");
        const appendMarker = (extra) => {
          fs.appendFileSync(
            markerPath,
            `${JSON.stringify({
              ...extra,
              at: new Date().toISOString(),
              callbackId: ctx.callbackId,
              chatId: ctx.callback.chatId,
              messageId: ctx.callback.messageId,
              namespace: ctx.callback.namespace,
              payload: ctx.callback.payload,
              senderId: ctx.senderId,
            })}\n`,
          );
        };
        appendMarker({
          stage: "received",
        });
        try {
          await ctx.respond.clearButtons();
          appendMarker({
            stage: "clearButtons:ok",
          });
        } catch (err) {
          appendMarker({
            stage: "clearButtons:error",
            error: String(err && err.stack ? err.stack : err),
          });
        }
        try {
          await ctx.respond.reply({
            text: `PR #97174 proof handled by code-agent handler: ${ctx.callback.payload}`,
          });
          appendMarker({
            stage: "reply:ok",
          });
        } catch (err) {
          appendMarker({
            stage: "reply:error",
            error: String(err && err.stack ? err.stack : err),
          });
        }
        appendMarker({
          stage: "return",
        });
        return { handled: true };
      },
    });
  },
};
