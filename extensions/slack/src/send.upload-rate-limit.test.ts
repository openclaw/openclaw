import type { IncomingMessage, ServerResponse } from "node:http";
// Real send owner, Slack SDK and loopback transport; media loading and the
// SSRF adapter are synthetic so no external Slack service or filesystem is used.
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { createSlackWriteClient } from "./client.js";
import { sendMessageSlack } from "./send.js";

vi.mock("openclaw/plugin-sdk/outbound-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/outbound-media")>()),
  loadOutboundMediaFromUrl: async () => ({
    buffer: Buffer.from("synthetic upload"),
    contentType: "text/plain",
    kind: "document",
    fileName: "answer.txt",
  }),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: async (
    params: Parameters<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>[0],
  ) => {
    params.beforeRequest?.();
    return {
      response: await fetch(params.url, { ...params.init, signal: params.signal }),
      finalUrl: params.url,
      release: async () => {},
    };
  },
}));

const SLACK_TEST_CFG = { channels: { slack: { botToken: "synthetic-upload-fixture" } } };
const UPLOAD_URL = "/api/files.getUploadURLExternal";
const COMPLETE_URL = "/api/files.completeUploadExternal";
afterEach(() => vi.unstubAllEnvs());

function withUploadApi(
  run: (baseUrl: string, paths: string[]) => Promise<void>,
  complete: (req: IncomingMessage, res: ServerResponse, body: string) => void = (_req, res) => {
    res.end(JSON.stringify({ ok: true, files: [{ id: "F001" }] }));
  },
) {
  const paths: string[] = [];
  let apiRoot = "";
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
    vi.stubEnv(key, undefined);
  }
  return withServer(
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        paths.push(req.url ?? "");
        if (req.url === UPLOAD_URL) {
          res.end(JSON.stringify({ ok: true, upload_url: `${apiRoot}/upload`, file_id: "F001" }));
        } else if (req.url === "/upload") {
          res.end("ok");
        } else if (req.url === COMPLETE_URL) {
          complete(req, res, Buffer.concat(chunks).toString("utf8"));
        } else {
          res.writeHead(404);
          res.end("unexpected route");
        }
      });
    },
    async (baseUrl) => {
      apiRoot = baseUrl;
      await run(baseUrl, paths);
    },
  );
}

it.each([
  { stage: "upload URL", expectedPaths: [] },
  { stage: "raw transfer", expectedPaths: [UPLOAD_URL] },
  { stage: "completion", expectedPaths: [UPLOAD_URL, "/upload"] },
])("stops a revoked direct send before external $stage", async ({ expectedPaths }) => {
  vi.stubEnv("NO_PROXY", "*");
  await withUploadApi(async (baseUrl, paths) => {
    vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);
    await expect(
      sendMessageSlack("channel:C123CHAN", "caption", {
        cfg: SLACK_TEST_CFG,
        mediaUrl: "/tmp/direct-upload.png",
        assertDirectAdapterHandoff: () => {
          if (paths.length >= expectedPaths.length) {
            throw new Error("direct delivery is no longer active");
          }
        },
      }),
    ).rejects.toThrow();
    expect(paths).toEqual(expectedPaths);
  });
});

it("preserves upload dispatch after a completion rate limit followed by a lost response", async () => {
  const completions: string[] = [];
  const onDeliveryResult = vi.fn();
  await withUploadApi(
    async (baseUrl, events) => {
      const onPlatformSendDispatch = vi.fn(async () => {
        events.push("dispatch");
      });
      const client = createSlackWriteClient("synthetic-upload-fixture", {
        slackApiUrl: `${baseUrl}/api/`,
        teamId: "TWORKSPACE",
      });
      const error = await sendMessageSlack("channel:C123CHAN", "caption", {
        cfg: SLACK_TEST_CFG,
        client,
        mediaUrl: "/tmp/rate-limited-upload.png",
        onPlatformSendDispatch,
        onDeliveryResult,
      }).catch((cause: unknown) => cause);
      expect(events).toEqual([UPLOAD_URL, "/upload", "dispatch", COMPLETE_URL, COMPLETE_URL]);
      expect(completions[0]).toBe(completions[1]);
      expect(new URLSearchParams(completions[1]).get("team_id")).toBe("TWORKSPACE");
      expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect(onDeliveryResult).not.toHaveBeenCalled();
    },
    (req, res, body) => {
      completions.push(body);
      if (completions.length === 1) {
        res.writeHead(429, { "retry-after": "0" });
        res.end(JSON.stringify({ ok: false, error: "ratelimited" }));
      } else {
        req.socket.destroy();
      }
    },
  );
});
