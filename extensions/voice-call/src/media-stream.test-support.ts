import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
} from "openclaw/plugin-sdk/realtime-transcription";
import type { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { MediaStreamHandler, type MediaStreamConfig } from "./media-stream.js";
import { connectWs, startUpgradeWsServer } from "./websocket-test-support.js";

export const createStubSession = (): RealtimeTranscriptionSession => ({
  connect: async () => {},
  sendAudio: () => {},
  close: () => {},
  isConnected: () => true,
});
export const createStubSttProvider = (
  createSession: RealtimeTranscriptionProviderPlugin["createSession"] = createStubSession,
): RealtimeTranscriptionProviderPlugin => ({
  createSession,
  id: "openai",
  label: "OpenAI",
  isConfigured: () => true,
});
export const createHandler = (config: Partial<MediaStreamConfig> = {}) =>
  new MediaStreamHandler({
    transcriptionProvider: createStubSttProvider(),
    providerConfig: {},
    ...config,
  });
export const waitForAbort = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
    } else {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }
  });
export const startWsServer = (handler: MediaStreamHandler) =>
  startUpgradeWsServer({
    urlPath: "/voice/stream",
    onUpgrade: (request, socket, head) => handler.handleUpgrade(request, socket, head),
  });
export function sendStart(
  ws: WebSocket,
  streamSid: string,
  callSid: string,
  customParameters?: Record<string, string>,
) {
  ws.send(
    JSON.stringify({
      event: "start",
      streamSid,
      start: { callSid, ...(customParameters && { customParameters }) },
    }),
  );
}
export async function withConnection(
  handler: MediaStreamHandler,
  run: (ws: WebSocket, url: string) => Promise<void>,
) {
  const server = await startWsServer(handler);
  try {
    await run(await connectWs(server.url), server.url);
  } finally {
    await server.close();
  }
}
