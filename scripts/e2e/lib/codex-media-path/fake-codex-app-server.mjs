// Fake Codex app server used by media-path E2E scenarios.
import {
  createFakeInitializeResponse,
  createFakeThreadStartResponse,
  runFakeCodexAppServer,
} from "../codex-app-server-fixture.mjs";

const version = "0.159.1";
const requestLog =
  process.env.OPENCLAW_CODEX_MEDIA_PATH_APP_SERVER_LOG ??
  "/tmp/openclaw-codex-media-path-app-server.jsonl";
let turnCount = 0;

runFakeCodexAppServer({
  requestLog,
  handlers: {
    initialize: ({ sendResult }) =>
      sendResult(
        createFakeInitializeResponse({
          name: "openclaw-codex-media-path-e2e",
          version,
          userAgent: `openclaw-codex-media-path-e2e/${version} (Docker; test)`,
        }),
      ),
    "model/list": ({ sendResult }) =>
      sendResult({
        data: [
          {
            id: "gpt-5.6-luna",
            model: "gpt-5.6-luna",
            displayName: "gpt-5.6-luna",
            description: "Codex media-path fixture model",
            hidden: false,
            isDefault: true,
            inputModalities: ["text", "image"],
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }],
          },
        ],
        nextCursor: null,
      }),
    "thread/list": ({ sendResult }) =>
      sendResult({ data: [], nextCursor: null, backwardsCursor: null }),
    "thread/start": ({ params, sendResult }) =>
      sendResult(
        createFakeThreadStartResponse({
          params,
          threadId: "thread-codex-media-path-e2e",
          sessionId: "session-codex-media-path-e2e",
          version,
        }),
      ),
    "turn/start": ({ sendResult }) => {
      turnCount += 1;
      sendResult({
        turn: {
          id: `turn-codex-media-path-e2e-${turnCount}`,
          status: "completed",
          items: [
            {
              type: "agentMessage",
              id: `msg-codex-media-path-e2e-${turnCount}`,
              text: "CODEX_MEDIA_PATH_E2E_OK",
            },
          ],
        },
      });
    },
  },
});
