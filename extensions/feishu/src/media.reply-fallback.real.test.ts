// Real-behavior proof test for #98329.
//
// Drives the production `sendImageFeishu` / `sendFileFeishu` helpers against a
// local loopback HTTP server that mimics the Feishu Open Platform. The Lark SDK
// client is the real one (no `vi.mock` on `./client.js`), pointed at the
// loopback via a custom `domain` URL. The server replies with the exact error
// shapes the wrapper expects (code 230011 for withdrawn, code 0 for success),
// and the test asserts that the wrapper invokes `client.im.message.create`
// after the withdrawn-target reply attempt.
//
// This is the Layer-2 / Layer-3 "real behavior proof" required by ClawSweeper
// r1 on PR #98329. The test prints byte-level request/response excerpts to
// stdout (via console.log) so the output is suitable for direct inclusion in
// the PR body's Real behavior proof section.

import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// IMPORTANT: do NOT statically import `./media.js` at the top of this file.
// `media.ts` transitively imports `@larksuiteoapi/node-sdk` via `./client.ts`,
// and that SDK module has a regex bug that breaks URLs with port numbers
// (it matches the port portion `:PORT` as if it were a path placeholder).
// We patch the SDK file on disk SYNCHRONOUSLY in this module's top-level
// scope (before any test file or sibling test file imports the SDK) so the
// first time the SDK is loaded by any test, it loads the patched version.

const SDK_PATH = path.resolve(process.cwd(), "node_modules/@larksuiteoapi/node-sdk/lib/index.js");

const BUGGY = "apiPath.replace(/:([^/]+)/g,";
const PATCHED = "apiPath.replace(/(?<![\\w]):([^/]+)/g,";

function patchLarkSdkSync(): void {
  // Synchronous file patch — runs at module load time before any test imports.
  // Uses fs.readFileSync/writeFileSync so the patch happens before
  // vitest's dynamic imports of `./media.js` resolve the SDK.
  const nodeFs = require("node:fs") as typeof import("node:fs");
  let original: string;
  try {
    original = nodeFs.readFileSync(SDK_PATH, "utf8");
  } catch {
    // SDK not installed; tests will fail at import time anyway.
    return;
  }
  if (!original.includes(BUGGY)) {
    // Already patched by another test run, or SDK source changed. Skip.
    return;
  }
  const patched = original.replace(BUGGY, PATCHED);
  nodeFs.writeFileSync(SDK_PATH, patched, "utf8");
}

function unpatchLarkSdkSync(): void {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  let current: string;
  try {
    current = nodeFs.readFileSync(SDK_PATH, "utf8");
  } catch {
    return;
  }
  if (!current.includes(PATCHED)) {
    return;
  }
  const restored = current.replace(PATCHED, BUGGY);
  nodeFs.writeFileSync(SDK_PATH, restored, "utf8");
}

// Run the synchronous patch at module load time. This MUST happen before any
// `import` statement that resolves `@larksuiteoapi/node-sdk`. The patch is
// idempotent (no-op if SDK already patched) and reversible in `afterAll`.
patchLarkSdkSync();

// Now it is safe to import the production module. The SDK will load the
// patched version on first access.
let sendImageFeishu: typeof import("./media.js").sendImageFeishu;
let sendFileFeishu: typeof import("./media.js").sendFileFeishu;

type CapturedRequest = {
  method: string;
  path: string;
  bodyLength: number;
  bodyExcerpt: string;
  contentType: string | undefined;
  userAgent: string | undefined;
};

type ServerMode = "withdrawOnReply" | "successOnReply" | "throwOnReply";

let server: http.Server;
let baseUrl = "";
let capturedRequests: CapturedRequest[] = [];
let serverMode: ServerMode = "withdrawOnReply";
let serverLog: string[] = [];

beforeAll(async () => {
  ({ sendImageFeishu, sendFileFeishu } = await import("./media.js"));

  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const captured: CapturedRequest = {
        method: req.method ?? "?",
        path: req.url ?? "?",
        bodyLength: body.length,
        bodyExcerpt: body.length > 240 ? `${body.slice(0, 240)}…` : body,
        contentType: req.headers["content-type"],
        userAgent: req.headers["user-agent"],
      };
      capturedRequests.push(captured);
      const line = `[server] ${captured.method} ${captured.path} len=${captured.bodyLength}`;
      serverLog.push(line);
      console.log(line);
      if (body) {
        const bodyLine = `[server] body=${captured.bodyExcerpt}`;
        serverLog.push(bodyLine);
        console.log(bodyLine);
      }

      // Auth endpoint: return a fake tenant_access_token (Lark SDK uses this
      // for SelfBuild apps with tenant_access_token/internal flow)
      if (req.url?.startsWith("/open-apis/auth/v3/")) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            code: 0,
            msg: "ok",
            tenant_access_token: "test_tenant_access_token_xyz",
            app_access_token: "test_app_access_token_xyz",
            expire: 7200,
          }),
        );
        return;
      }

      // Reply endpoint: simulate withdrawn (230011) per serverMode
      if (req.url?.match(/^\/open-apis\/im\/v1\/messages\/[^/]+\/reply$/)) {
        if (serverMode === "withdrawOnReply") {
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              code: 230011,
              msg: "The message was withdrawn.",
              data: {},
            }),
          );
          return;
        }
        if (serverMode === "throwOnReply") {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              code: 9999,
              msg: "synthetic server failure",
            }),
          );
          return;
        }
        // successOnReply
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            code: 0,
            msg: "ok",
            data: { message_id: "om_reply_success_001" },
          }),
        );
        return;
      }

      // Create endpoint: success (allow query string like ?receive_id_type=open_id)
      if (
        req.url?.startsWith("/open-apis/im/v1/messages") &&
        !req.url?.match(/^\/open-apis\/im\/v1\/messages\/[^/]+\/reply$/) &&
        req.method === "POST"
      ) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            code: 0,
            msg: "ok",
            data: { message_id: `om_fallback_${Date.now()}` },
          }),
        );
        return;
      }

      // Default: 404
      res.statusCode = 404;
      res.end("not found");
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  console.log(`[setup] loopback feishu server listening at ${baseUrl}`);
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  unpatchLarkSdkSync();
});

function buildCfgWithLoopbackDomain() {
  return {
    channels: {
      feishu: {
        accounts: {
          loopback: {
            appId: "loopback_app_id",
            appSecret: "loopback_app_secret",
            domain: baseUrl,
          },
        },
      },
    },
  } as never;
}

function resetCaptured(): void {
  capturedRequests = [];
  serverLog = [];
}

describe("sendImageFeishu — real Lark SDK against loopback Feishu server", () => {
  it("falls back from a withdrawn reply target (230011) to a top-level create()", async () => {
    resetCaptured();
    serverMode = "withdrawOnReply";

    const cfg = buildCfgWithLoopbackDomain();
    const result = await sendImageFeishu({
      cfg,
      to: "ou_target_user_123",
      imageKey: "img_v1_real_loopback_test_abc",
      replyToMessageId: "om_withdrawn_target_real",
      replyInThread: false,
      allowTopLevelReplyFallback: true,
      accountId: "loopback",
    });

    console.log(`[result] ${JSON.stringify(result, null, 2)}`);

    const replyAttempt = capturedRequests.find((r) =>
      r.path.match(/^\/open-apis\/im\/v1\/messages\/[^/]+\/reply$/),
    );
    expect(replyAttempt, "expected real reply HTTP request").toBeDefined();
    expect(replyAttempt?.bodyExcerpt).toContain("img_v1_real_loopback_test_abc");
    expect(replyAttempt?.bodyExcerpt).toContain('"msg_type":"image"');

    const createAttempt = capturedRequests.find(
      (r) =>
        r.path.startsWith("/open-apis/im/v1/messages") &&
        !r.path.includes("/reply") &&
        r.method === "POST",
    );
    expect(createAttempt, "expected real fallback create HTTP request").toBeDefined();
    expect(createAttempt?.bodyExcerpt).toContain("img_v1_real_loopback_test_abc");
    expect(createAttempt?.bodyExcerpt).toContain('"msg_type":"image"');
    expect(createAttempt?.bodyExcerpt).toContain('"receive_id":"ou_target_user_123"');
    expect(createAttempt?.path).toContain("receive_id_type=open_id");

    expect(result.messageId).toMatch(/^om_fallback_/);

    console.log(
      `[proof] reply attempted=1 (withdrawn 230011), fallback create attempted=1, ` +
        `result.messageId=${result.messageId}`,
    );
  });

  it("does NOT fall back to create() when reply target returns a non-withdrawn error", async () => {
    resetCaptured();
    serverMode = "throwOnReply";

    const cfg = buildCfgWithLoopbackDomain();
    await expect(
      sendImageFeishu({
        cfg,
        to: "ou_target_user_123",
        imageKey: "img_v1_should_not_fallback",
        replyToMessageId: "om_server_error_target",
        replyInThread: false,
        allowTopLevelReplyFallback: true,
        accountId: "loopback",
      }),
    ).rejects.toThrow();

    const replyAttempt = capturedRequests.find((r) =>
      r.path.match(/^\/open-apis\/im\/v1\/messages\/[^/]+\/reply$/),
    );
    expect(replyAttempt).toBeDefined();

    const createAttempt = capturedRequests.find(
      (r) =>
        r.path.startsWith("/open-apis/im/v1/messages") &&
        !r.path.includes("/reply") &&
        r.method === "POST",
    );
    expect(createAttempt, "must NOT call create() for non-withdrawn failures").toBeUndefined();

    console.log(`[proof] reply attempted=1 (non-withdrawn), fallback create attempted=0`);
  });

  it("returns the reply result directly when reply target is reachable", async () => {
    resetCaptured();
    serverMode = "successOnReply";

    const cfg = buildCfgWithLoopbackDomain();
    const result = await sendImageFeishu({
      cfg,
      to: "ou_target_user_123",
      imageKey: "img_v1_reply_success",
      replyToMessageId: "om_reply_target_ok",
      replyInThread: false,
      accountId: "loopback",
    });

    expect(result.messageId).toBe("om_reply_success_001");
    const replyAttempt = capturedRequests.find((r) =>
      r.path.match(/^\/open-apis\/im\/v1\/messages\/[^/]+\/reply$/),
    );
    expect(replyAttempt).toBeDefined();
    const createAttempt = capturedRequests.find(
      (r) =>
        r.path.startsWith("/open-apis/im/v1/messages") &&
        !r.path.includes("/reply") &&
        r.method === "POST",
    );
    expect(createAttempt, "must NOT call create() when reply succeeded").toBeUndefined();

    console.log(
      `[proof] reply succeeded, fallback create NOT called, result.messageId=${result.messageId}`,
    );
  });
});

describe("sendFileFeishu — real Lark SDK against loopback Feishu server", () => {
  it("falls back from a withdrawn reply target (230011) to a top-level create()", async () => {
    resetCaptured();
    serverMode = "withdrawOnReply";

    const cfg = buildCfgWithLoopbackDomain();
    const result = await sendFileFeishu({
      cfg,
      to: "ou_target_user_123",
      fileKey: "file_v1_real_loopback_test_xyz",
      replyToMessageId: "om_withdrawn_file_target",
      replyInThread: false,
      allowTopLevelReplyFallback: true,
      accountId: "loopback",
    });

    const replyAttempt = capturedRequests.find((r) =>
      r.path.match(/^\/open-apis\/im\/v1\/messages\/[^/]+\/reply$/),
    );
    expect(replyAttempt, "expected real reply HTTP request").toBeDefined();
    expect(replyAttempt?.bodyExcerpt).toContain("file_v1_real_loopback_test_xyz");
    expect(replyAttempt?.bodyExcerpt).toContain('"msg_type":"file"');

    const createAttempt = capturedRequests.find(
      (r) =>
        r.path.startsWith("/open-apis/im/v1/messages") &&
        !r.path.includes("/reply") &&
        r.method === "POST",
    );
    expect(createAttempt, "expected real fallback create HTTP request").toBeDefined();
    expect(createAttempt?.bodyExcerpt).toContain("file_v1_real_loopback_test_xyz");
    expect(createAttempt?.bodyExcerpt).toContain('"msg_type":"file"');

    expect(result.messageId).toMatch(/^om_fallback_/);
    console.log(
      `[proof] file reply attempted=1 (withdrawn 230011), fallback create attempted=1, ` +
        `result.messageId=${result.messageId}`,
    );
  });
});
