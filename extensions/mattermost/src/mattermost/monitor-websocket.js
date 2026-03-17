import WebSocket from "ws";
import { rawDataToString } from "./monitor-helpers.js";
class WebSocketClosedBeforeOpenError extends Error {
  constructor(code, reason) {
    super(`websocket closed before open (code ${code})`);
    this.code = code;
    this.reason = reason;
    this.name = "WebSocketClosedBeforeOpenError";
  }
}
const defaultMattermostWebSocketFactory = (url) => new WebSocket(url);
function parsePostedPayload(payload) {
  if (payload.event !== "posted") {
    return null;
  }
  const postData = payload.data?.post;
  if (!postData) {
    return null;
  }
  let post = null;
  if (typeof postData === "string") {
    try {
      post = JSON.parse(postData);
    } catch {
      return null;
    }
  } else if (typeof postData === "object") {
    post = postData;
  }
  if (!post) {
    return null;
  }
  return { payload, post };
}
function parsePostedEvent(data) {
  const raw = rawDataToString(data);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  return parsePostedPayload(payload);
}
function createMattermostConnectOnce(opts) {
  const webSocketFactory = opts.webSocketFactory ?? defaultMattermostWebSocketFactory;
  return async () => {
    const ws = webSocketFactory(opts.wsUrl);
    const onAbort = () => ws.terminate();
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await new Promise((resolve, reject) => {
        let opened = false;
        let settled = false;
        const resolveOnce = () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve();
        };
        const rejectOnce = (error) => {
          if (settled) {
            return;
          }
          settled = true;
          reject(error);
        };
        ws.on("open", () => {
          opened = true;
          opts.statusSink?.({
            connected: true,
            lastConnectedAt: Date.now(),
            lastError: null
          });
          ws.send(
            JSON.stringify({
              seq: opts.nextSeq(),
              action: "authentication_challenge",
              data: { token: opts.botToken }
            })
          );
        });
        ws.on("message", async (data) => {
          const raw = rawDataToString(data);
          let payload;
          try {
            payload = JSON.parse(raw);
          } catch {
            return;
          }
          if (payload.event === "reaction_added" || payload.event === "reaction_removed") {
            if (!opts.onReaction) {
              return;
            }
            try {
              await opts.onReaction(payload);
            } catch (err) {
              opts.runtime.error?.(`mattermost reaction handler failed: ${String(err)}`);
            }
            return;
          }
          if (payload.event !== "posted") {
            return;
          }
          const parsed = parsePostedPayload(payload);
          if (!parsed) {
            return;
          }
          try {
            await opts.onPosted(parsed.post, parsed.payload);
          } catch (err) {
            opts.runtime.error?.(`mattermost handler failed: ${String(err)}`);
          }
        });
        ws.on("close", (code, reason) => {
          const message = reasonToString(reason);
          opts.statusSink?.({
            connected: false,
            lastDisconnect: {
              at: Date.now(),
              status: code,
              error: message || void 0
            }
          });
          if (opened) {
            resolveOnce();
            return;
          }
          rejectOnce(new WebSocketClosedBeforeOpenError(code, message || void 0));
        });
        ws.on("error", (err) => {
          opts.runtime.error?.(`mattermost websocket error: ${String(err)}`);
          opts.statusSink?.({
            lastError: String(err)
          });
          try {
            ws.close();
          } catch {
          }
        });
      });
    } finally {
      opts.abortSignal?.removeEventListener("abort", onAbort);
    }
  };
}
function reasonToString(reason) {
  if (!reason) {
    return "";
  }
  if (typeof reason === "string") {
    return reason;
  }
  return reason.length > 0 ? reason.toString("utf8") : "";
}
export {
  WebSocketClosedBeforeOpenError,
  createMattermostConnectOnce,
  defaultMattermostWebSocketFactory,
  parsePostedEvent,
  parsePostedPayload
};
