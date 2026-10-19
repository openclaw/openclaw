import { createHash, randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import type { Plugin } from "vite";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  ProgressCard,
  ProjectsListResult,
  UserProfile,
  SessionsDiffResult,
  SessionFileEntry,
  SessionFileBrowserEntry,
  SessionsFilesListResult,
  ArtifactSummary,
  BoardSnapshot,
  EnvironmentSummary,
  PortalListResult,
  SessionCompanionExchange,
  SessionsCompanionAskParams,
} from "../packages/gateway-protocol/src/index.js";
import {
  CANVAS_DOCUMENT_PREVIEW_MAX_BYTES,
  type CanvasDocumentPreviewParams,
  type CanvasDocumentViewResult,
} from "../packages/gateway-protocol/src/schema/canvas.js";
import { CronRunsParamsSchema } from "../packages/gateway-protocol/src/schema/cron.js";
import {
  DesktopObserveParamsSchema,
  DesktopReleaseParamsSchema,
  type DesktopObserveResult,
} from "../packages/gateway-protocol/src/schema/desktop.js";
import type {
  SessionGitHubOptionsResult,
  SessionGitHubPublishParams,
  SessionGitHubStatusParamsSchema,
  SessionGitHubStatusResult,
} from "../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { SessionCreatedActor } from "../packages/gateway-protocol/src/schema/sessions-row.js";
import type {
  SessionMembersListEvidenceResult,
  SessionMembersListParams,
  SessionMemberAddParams,
  SessionMemberMutationResult,
  SessionPublicShareSetParams,
  SessionPublicShareSetResult,
  SessionVisibilitySetParams,
} from "../packages/gateway-protocol/src/schema/sessions-sharing.js";
import {
  SessionsFilesGetParamsSchema,
  SessionsFilesSetParamsSchema,
  SessionsFilesListParamsSchema,
  type SessionsFilesGetResult,
  type SessionsFilesDownloadResult,
  type SessionsFilesAssetsParams,
  type SessionsFilesAssetsResult,
} from "../packages/gateway-protocol/src/schema/sessions.js";
import type { WorktreesListResult } from "../packages/gateway-protocol/src/schema/worktrees.js";
import { buildSandboxHostPath } from "../src/agents/sandbox-host.js";
import type { SessionSystemPromptReport } from "../src/config/sessions/session-system-prompt-report.js";
import { projectCronRunHistoryPage } from "../src/cron/run-history.js";
import type { CronRunRecord } from "../src/cron/store/run-history.types.js";
import type {
  ControlUiSessionPullRequestSnapshot,
  ControlUiSessionPullRequestsChanged,
} from "../src/gateway/control-ui-contract.js";
import { createSandboxHostHttpServer } from "../src/gateway/mcp-app-sandbox-http.js";
import { cronRunLogPageFilters } from "../src/gateway/server-methods/cron-run-log-filters.js";
import { WORKSPACE_PREVIEW_MAX_BYTES } from "../src/gateway/workspace-file-limits.js";
import { readJsonBodyWithLimit } from "../src/infra/http-body.js";
import type {
  ControlUiLinkReaderDescriptor,
  ControlUiLinkReaderDocument,
} from "../src/shared/control-ui-link-reader.js";
import type { SessionsUsageResult } from "../src/shared/usage-types.js";
import type { CronJob, GatewaySessionRow } from "../ui/src/api/types.ts";
import { createRfbRawFrame } from "../ui/src/e2e/desktop-rfb-test-support.ts";
import type {
  ControlUiMockGateway,
  ControlUiMockGatewayScenario,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { createControlUiMockSessionRow as sessionRow } from "../ui/src/test-helpers/control-ui-session-fixtures.ts";
import { cronListResponseFixture } from "../ui/src/test-helpers/cron.ts";

type SessionGitHubStatusParams = Static<typeof SessionGitHubStatusParamsSchema>;

const MAIN = "agent:main:main";
const ROOT = "/mock/workspace";
const CHILD = "agent:main:subagent:release-review";
const HANDOFF = "agent:main:handoff";
const MOBILE_QUEUE = "agent:main:mobile-queue";
const MOBILE_SWARM = "agent:main:mobile-swarm";
const WORKER_ENVIRONMENT_ID = "synthetic-release-worker";
const HANDOFF_BRANCH = "docs/launch-handoff";
const HANDOFF_WORKTREE_ID = "session-design-launch-handoff";
const SESSION_DESIGN_PORTAL_PATH = "/__fixtures/session-design/release.html";
const sessionDesignPortalHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Autumn release readiness</title>
  <style>
    :root { color-scheme: light dark; background: Canvas; color: CanvasText; font: 16px/1.6 system-ui, sans-serif; }
    body { max-width: 48rem; margin: 0 auto; padding: 2rem 1.25rem; }
    h1 { font-size: 1.75rem; line-height: 1.2; }
    h2 { font-size: 1.1rem; margin-top: 2rem; }
    li { margin-block: .75rem; }
    small { opacity: .7; }
  </style>
</head>
<body>
  <main>
    <small>Release handoff · October 17</small>
    <h1>Autumn release readiness</h1>
    <p>The session workspace is ready for its final review. Documentation is the remaining handoff item.</p>
    <h2>Release checklist</h2>
    <ul>
      <li><strong>Panel controls:</strong> review tab selection, placement, and closing behavior.</li>
      <li><strong>Documentation:</strong> review is in progress; confirm examples and migration notes.</li>
      <li><strong>Release links:</strong> checked and ready for the handoff.</li>
    </ul>
    <h2>Next steps</h2>
    <p>Finish the documentation review, inspect the changed files, and share the completed checklist with the release owner.</p>
  </main>
</body>
</html>`;

/** Passive local document: no app bootstrap, remote service, or authentication claim. */
export function createSessionDesignPortalFixturePlugin(): Plugin {
  return {
    name: "openclaw-session-design-portal-fixture",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?", 1)[0] !== SESSION_DESIGN_PORTAL_PATH) {
          next();
          return;
        }
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET, HEAD");
          res.end();
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(req.method === "HEAD" ? undefined : sessionDesignPortalHtml);
      });
    },
  };
}
export type SessionDesignSandbox = {
  sandboxUrl: string;
  sandboxPort: number;
  sandboxOrigin: string;
};

/** The native sandbox owns document policy; the mock only owns this listener's lifetime. */
export async function startSessionDesignSandbox() {
  const server = createSandboxHostHttpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Sandbox did not bind");
  }
  const descriptor: SessionDesignSandbox = {
    sandboxUrl: buildSandboxHostPath({ blockDescendantFrames: true }),
    sandboxPort: address.port,
    sandboxOrigin: `http://127.0.0.1:${address.port}`,
  };
  let closing: Promise<void> | undefined;
  return {
    descriptor,
    close() {
      return (closing ??= new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }));
    },
  };
}

/** Session-design-only RFB endpoint. No host capture, credentials, or remote sockets. */
export function createSessionDesignDesktopFixturePlugin(): Plugin {
  const endpoint = "/__fixtures/session-design/desktop";
  const leases = new Map<string, { control: boolean; expiresAtMs: number; socket?: WebSocket }>();
  const sockets = new WebSocketServer({ noServer: true });
  // Reuse the canonical Desktop harness's Raw rectangle and mark its pixels as synthetic.
  const stamp = Buffer.from(createRfbRawFrame());
  const glyphs = ["110101101101110", "111100110100111", "101111111101101", "111101101101111"];
  for (const [letter, glyph] of glyphs.entries()) {
    for (let pixel = 0; pixel < 15; pixel += 1) {
      if (glyph[pixel] !== "1") {
        continue;
      }
      for (let dy = 0; dy < 3; dy += 1) {
        for (let dx = 0; dx < 3; dx += 1) {
          const x = 24 + letter * 12 + (pixel % 3) * 3 + dx;
          const y = 24 + Math.floor(pixel / 3) * 3 + dy;
          stamp.set([0, 0, 0, 0], 16 + (y * 96 + x) * 4);
        }
      }
    }
  }
  const frame = Buffer.alloc(16 + 768 * 512 * 4);
  frame.writeUInt16BE(1, 2);
  frame.writeUInt16BE(768, 8);
  frame.writeUInt16BE(512, 10);
  for (let y = 0; y < 512; y += 1) {
    for (let x = 0; x < 768; x += 1) {
      const pixel = 16 + (Math.floor(y / 8) * 96 + Math.floor(x / 8)) * 4;
      stamp.copy(frame, 16 + (y * 768 + x) * 4, pixel, pixel + 4);
    }
  }
  return {
    name: "openclaw-session-design-desktop-fixture",
    configureServer(server) {
      const http = server.httpServer;
      if (!http) {
        throw new Error("Synthetic desktop requires the mock HTTP server");
      }
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://session-design.invalid");
        if (url.pathname !== endpoint || req.method !== "POST") {
          next();
          return;
        }
        const respond = (payload: unknown) => {
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(payload));
        };
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.from(chunk));
          }
          const params: unknown = JSON.parse(Buffer.concat(chunks).toString());
          if (
            url.searchParams.get("method") === "desktop.observe" &&
            Value.Check(DesktopObserveParamsSchema, params)
          ) {
            if (
              params.source.kind !== "host" &&
              !(params.source.kind === "environment" && params.source.environmentId === "gateway")
            ) {
              respond({
                __mockError: {
                  code: "UNAVAILABLE",
                  message: "Only the synthetic Gateway desktop is simulated.",
                },
              });
              return;
            }
            const wsPath = `${endpoint}?lease=${randomUUID()}`;
            const lease = { control: params.control === true, expiresAtMs: Date.now() + 300_000 };
            leases.set(wsPath, lease);
            respond({
              transport: "rfb",
              wsPath,
              ...lease,
              auth: "none",
              canResize: false,
            } satisfies DesktopObserveResult);
          } else if (
            url.searchParams.get("method") === "desktop.release" &&
            Value.Check(DesktopReleaseParamsSchema, params)
          ) {
            const lease = leases.get(params.wsPath);
            leases.delete(params.wsPath);
            lease?.socket?.close(1000, "Synthetic desktop released");
            respond({ released: Boolean(lease) });
          } else {
            respond({
              __mockError: {
                code: "INVALID_REQUEST",
                message: "Invalid synthetic desktop request.",
              },
            });
          }
        })().catch(() =>
          respond({
            __mockError: { code: "INVALID_REQUEST", message: "Invalid synthetic desktop payload." },
          }),
        );
      });
      http.on("upgrade", (request, socket, head) => {
        if (request.url?.split("?", 1)[0] !== endpoint) {
          return;
        }
        const lease = leases.get(request.url);
        if (!lease || lease.expiresAtMs < Date.now() || lease.socket) {
          socket.destroy();
          return;
        }
        sockets.handleUpgrade(request, socket, head, (peer) => {
          lease.socket = peer;
          let stage = 0;
          peer.send("RFB 003.008\n", { binary: true });
          peer.on("message", (data) => {
            stage += 1;
            if (stage === 1) {
              peer.send(Buffer.from([1, 1]));
            } else if (stage === 2) {
              peer.send(Buffer.alloc(4));
            } else if (stage === 3) {
              const name = Buffer.from("Synthetic DEMO — no remote computer");
              const init = Buffer.alloc(24 + name.length);
              init.writeUInt16BE(768, 0);
              init.writeUInt16BE(512, 2);
              init.set([32, 24, 0, 1], 4);
              for (const offset of [8, 10, 12]) {
                init.writeUInt16BE(255, offset);
              }
              init.set([16, 8, 0], 14);
              init.writeUInt32BE(name.length, 20);
              name.copy(init, 24);
              peer.send(init);
            } else if (Buffer.isBuffer(data) && data[0] === 3 && data[1] === 0) {
              peer.send(frame);
            }
            // Input is intentionally inert: this endpoint cannot control any host.
          });
          peer.on("close", () => leases.delete(request.url!));
        });
      });
      http.on("close", () => {
        for (const peer of sockets.clients) {
          peer.terminate();
        }
        sockets.close();
        leases.clear();
      });
    },
  };
}

type SessionDesignFileSample = {
  name: string;
  mimeType: string;
  bytes: Buffer;
  previewKind: "text" | "image" | "unsupported";
};

function sessionDesignFileSamples(): SessionDesignFileSample[] {
  const texts: Array<[string, string, string]> = [
    ["notes.txt", "text/plain", "Release notes — Café Ω\n\nOwner: Mira\nReview complete.\n"],
    [
      "session.log",
      "text/plain",
      Array.from(
        { length: 120 },
        (_, index) =>
          `2026-10-18T09:00:${String(index % 60).padStart(2, "0")}Z INFO synthetic step=${index} ${"review details ".repeat(20)}`,
      ).join("\n"),
    ],
    ["example.js", "text/javascript", "export function label(name) { return `Hello, ${name}`; }\n"],
    [
      "example.tsx",
      "text/typescript",
      "export const Release = () => <article><h1>Release review</h1></article>;\n",
    ],
    [
      "example.py",
      "text/x-python",
      "def release_label(name: str) -> str:\n    return f'Release: {name}'\n",
    ],
    [
      "example.sh",
      "text/x-shellscript",
      "#!/bin/sh\n# Synthetic review script; not executed.\nprintf '%s\\n' 'Ready for review'\n",
    ],
    ["example.css", "text/css", ".release { display: grid; gap: 1rem; color: #246; }\n"],
    [
      "example.html",
      "text/html",
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic release</title><h1>Release preview</h1><p>Local fixture — no external resources.</p></html>',
    ],
    [
      "example.json",
      "application/json",
      '{"release":"autumn","reviewed":true,"owners":["Mira","Riley"]}\n',
    ],
    [
      "example.yaml",
      "text/yaml",
      "release: autumn\nreviewed: true\nowners:\n  - Mira\n  - Riley\n",
    ],
    [
      "example.csv",
      "text/csv",
      "owner,task,status\nMira,Documentation,reviewing\nRiley,Links,done\n",
    ],
    ["empty.txt", "text/plain", ""],
    [
      "release-review-with-a-deliberately-long-filename-for-horizontal-navigation-and-extension-preservation.ts",
      "text/typescript",
      "export const review: { status: string } = { status: 'ready' };\n",
    ],
  ];
  const samples = texts.map(([name, mimeType, text]): SessionDesignFileSample => ({
    name,
    mimeType,
    bytes: Buffer.from(text),
    previewKind: "text",
  }));
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#176b65"/><circle cx="74" cy="90" r="42" fill="#f5cc76"/><text x="138" y="98" font-family="sans-serif" font-size="22" fill="white">DEMO</text></svg>';
  samples.push({
    name: "preview.svg",
    mimeType: "image/svg+xml",
    bytes: Buffer.from(svg),
    previewKind: "text",
  });
  const chunk = (type: string, data: Buffer) => {
    const tag = Buffer.from(type);
    const output = Buffer.alloc(12 + data.length);
    output.writeUInt32BE(data.length);
    tag.copy(output, 4);
    data.copy(output, 8);
    output.writeUInt32BE(crc32(Buffer.concat([tag, data])), 8 + data.length);
    return output;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(320, 0);
  header.writeUInt32BE(180, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(180 * (1 + 320 * 3));
  for (let y = 0; y < 180; y += 1) {
    for (let x = 0; x < 320; x += 1) {
      const offset = y * 961 + 1 + x * 3;
      pixels.set([40 + (x % 180), 70 + (y % 150), 130], offset);
    }
  }
  samples.push({
    name: "preview.png",
    mimeType: "image/png",
    bytes: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(pixels)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
    previewKind: "image",
  });
  const stream =
    "BT /F1 22 Tf 48 730 Td (Synthetic release review) Tj 0 -36 Td /F1 12 Tf (Local PDF fixture - no remote document.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  samples.push({
    name: "review.pdf",
    mimeType: "application/pdf",
    bytes: Buffer.from(pdf),
    previewKind: "unsupported",
  });
  samples.push({
    name: "opaque.bin",
    mimeType: "application/octet-stream",
    bytes: Buffer.from([0, 1, 2, 3, 255]),
    previewKind: "unsupported",
  });
  return samples;
}

/** Download metadata belongs to a session/file version, even when bytes match. */
function sessionDesignFileDownloadUrl(
  sessionKey: string,
  file: Pick<SessionFileEntry, "path" | "hash">,
): string {
  const id = createHash("sha256")
    .update(JSON.stringify([sessionKey, file.path, file.hash]))
    .digest("hex");
  return `/api/artifacts/download/session-design/${id}`;
}

/** Serve only bytes already declared by the synthetic Files catalog. */
export function createSessionDesignFileFixturePlugin(
  scenario: ControlUiMockGatewayScenario,
): Plugin {
  const assets = new Map<string, { bytes: Buffer; mimeType: string; name: string }>();
  const historyStoreKey = "synthetic-session-design";
  const historyNow = Date.now();
  const historyJobs = [
    "mock-cron-release-digest",
    "mock-cron-inbox-triage",
    "mock-cron-calendar-sync",
  ];
  const historyStates = ["ok", "error", "ok", "skipped", "error", "ok"] as const;
  const historyRecords: CronRunRecord[] = historyJobs.flatMap((jobId) =>
    historyStates.map((status, index) => {
      const startedAt = historyNow - (index + 1) * 86_400_000;
      const durationMs = status === "skipped" ? 0 : 18_000 + index * 7_000;
      return {
        id: `${jobId}-history-${index}`,
        jobId,
        agentId: "main",
        createdAt: startedAt,
        startedAt,
        endedAt: startedAt + durationMs,
        status,
        summary:
          status === "ok"
            ? "Release digest prepared and delivered."
            : status === "skipped"
              ? "No new release changes to report."
              : "Delivery failed because the destination was unavailable.",
        detail: {
          kind: "cron-run",
          storeKey: historyStoreKey,
          status,
          runId: `${jobId}-run-${index}`,
          runAtMs: startedAt,
          durationMs,
          deliveryStatus:
            status === "ok"
              ? "delivered"
              : status === "skipped"
                ? "not-requested"
                : "not-delivered",
        },
      };
    }),
  );
  type Failure = typeof missing;
  type FileResponse = SessionsFilesGetResult | Failure;
  const get = scenario.methodResponses?.["sessions.files.get"] as {
    cases: Array<{ match?: { sessionKey: string; path: string }; response: FileResponse }>;
  };
  const downloads = scenario.methodResponses?.["sessions.files.download"] as {
    cases: Array<{
      match?: { sessionKey: string; path: string };
      response: SessionsFilesDownloadResult | Failure;
    }>;
  };
  const listings = scenario.methodResponses?.["sessions.files.list"] as {
    cases: Array<{
      match?: { sessionKey: string; path?: string };
      response: SessionsFilesListResult | Failure;
    }>;
  };
  const key = (sessionKey: string, path: string) => `${sessionKey}\0${path}`;
  const aliases = new Map<string, FileResponse>();
  const records = new Map<string, SessionsFilesGetResult>();
  const retainBytes = (sessionKey: string, file: SessionFileEntry) => {
    if (file.content !== undefined && file.hash) {
      assets.set(sessionDesignFileDownloadUrl(sessionKey, file), {
        bytes: Buffer.from(file.content, file.contentEncoding === "base64" ? "base64" : "utf8"),
        mimeType: file.mimeType ?? "text/plain",
        name: file.name,
      });
    }
  };
  for (const entry of get.cases) {
    if (!entry.match) {
      continue;
    }
    let response = entry.response;
    if ("file" in response) {
      const id = key(entry.match.sessionKey, response.file.path);
      // Aliases share one record; different sessions never share writable content.
      let record = records.get(id);
      if (!record) {
        record = structuredClone(response);
        records.set(id, record);
        retainBytes(record.sessionKey, record.file);
      }
      response = record;
    }
    aliases.set(key(entry.match.sessionKey, entry.match.path), response);
  }
  const fileError = (type: string, message: string, path: string, details = {}) => ({
    __mockError: { code: "INVALID_REQUEST", message, details: { type, path, ...details } },
  });
  const dispatch = (method: string | null, input: unknown): unknown => {
    if (method === "sessions.files.list" && Value.Check(SessionsFilesListParamsSchema, input)) {
      if (input.agentId && input.agentId !== "main") {
        return missing;
      }
      if (input.search?.trim()) {
        return unavailable;
      }
      const found = listings.cases.find(
        ({ match }) =>
          match?.sessionKey === input.sessionKey && (match.path ?? "") === (input.path ?? ""),
      );
      if (!found || !("files" in found.response)) {
        return missing;
      }
      const response = structuredClone(found.response);
      response.files = response.files.map((file) => {
        const current = records.get(key(input.sessionKey, file.path))?.file;
        if (!current) {
          return file;
        }
        const { content: _content, ...metadata } = current;
        return metadata;
      });
      for (const entry of response.browser?.entries ?? []) {
        const file = records.get(key(input.sessionKey, entry.path))?.file;
        if (file && entry.kind === "file") {
          entry.size = file.size;
          entry.sessionKind = file.kind;
        }
      }
      return response;
    }
    if (
      !Value.Check(SessionsFilesGetParamsSchema, input) &&
      !(method === "sessions.files.set" && Value.Check(SessionsFilesSetParamsSchema, input))
    ) {
      return missing;
    }
    if (input.agentId && input.agentId !== "main") {
      return missing;
    }
    // Exact closed aliases only: no path normalization, filesystem lookup or traversal.
    const record = aliases.get(key(input.sessionKey, input.path));
    if (!record || !("file" in record)) {
      return record ?? missing;
    }
    if (method === "sessions.files.get") {
      return record;
    }
    if (method === "sessions.files.download") {
      const found = downloads.cases.find(
        ({ match }) => match?.sessionKey === input.sessionKey && match.path === input.path,
      );
      if (!found || !("url" in found.response)) {
        return missing;
      }
      return {
        ...found.response,
        url: sessionDesignFileDownloadUrl(record.sessionKey, record.file),
      };
    }
    if (method !== "sessions.files.set" || !Value.Check(SessionsFilesSetParamsSchema, input)) {
      return missing;
    }
    const file = record.file;
    if (file.missing || file.previewKind !== "text" || file.contentEncoding !== "utf8") {
      return unavailable;
    }
    if (file.hash !== input.expectedHash) {
      return fileError(
        "session_file_conflict",
        "session file changed since it was read",
        input.path,
        { currentHash: file.hash },
      );
    }
    const bytes = Buffer.from(input.content, "utf8");
    if (bytes.length > WORKSPACE_PREVIEW_MAX_BYTES) {
      return fileError("session_file_too_large", "session file content is too large", input.path, {
        maxPreviewBytes: WORKSPACE_PREVIEW_MAX_BYTES,
        size: bytes.length,
      });
    }
    if (input.content.includes("\0") || bytes.toString("utf8") !== input.content) {
      return fileError(
        "session_file_unsafe",
        "session file could not be written safely",
        input.path,
      );
    }
    // Synchronous CAS and memory update. This never writes a workspace file.
    record.file = {
      ...file,
      content: input.content,
      size: bytes.length,
      kind: "modified",
      hash: createHash("sha256").update(bytes).digest("hex"),
      updatedAtMs: Date.now(),
    };
    retainBytes(record.sessionKey, record.file);
    return record;
  };
  return {
    name: "openclaw-session-design-file-bytes",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://session-design.invalid");
        const pathname = url.pathname;
        if (pathname === "/__fixtures/session-design/cron-runs" && req.method === "POST") {
          void (async () => {
            const body = await readJsonBodyWithLimit(req, { maxBytes: 16_384 });
            const response =
              body.ok && Value.Check(CronRunsParamsSchema, body.value)
                ? projectCronRunHistoryPage(historyRecords, {
                    storeKey: historyStoreKey,
                    ...cronRunLogPageFilters(body.value),
                    jobId:
                      body.value.scope === "all" ? undefined : (body.value.id ?? body.value.jobId),
                    agentId: body.value.agentId,
                  })
                : missing;
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify(response));
          })();
          return;
        }
        if (pathname === "/__fixtures/session-design/files" && req.method === "POST") {
          void (async () => {
            const body = await readJsonBodyWithLimit(req, {
              maxBytes: WORKSPACE_PREVIEW_MAX_BYTES * 6 + 4096,
            });
            const response = body.ok
              ? dispatch(url.searchParams.get("method"), body.value)
              : missing;
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify(response));
          })();
          return;
        }
        if (!pathname.startsWith("/api/artifacts/download/session-design/")) {
          next();
          return;
        }
        const asset = assets.get(pathname);
        res.setHeader("Cache-Control", "no-store");
        if (!asset) {
          res.statusCode = 404;
          res.end("Artifact download expired");
          return;
        }
        res.setHeader("Content-Type", asset.mimeType);
        res.setHeader(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
        );
        res.end(req.method === "HEAD" ? undefined : asset.bytes);
      });
    },
  };
}

const actor = (
  id: string,
  label: string,
): SessionCreatedActor & {
  id: string;
  identity: { type: "profile"; id: string };
  label: string;
} => ({
  type: "human",
  id,
  label,
  identity: { type: "profile", id },
});
const avery = actor("presence-avery", "Avery");
const mira = actor("profile-mira", "Mira");
const riley = actor("profile-riley", "Riley");
const participant = (person: ReturnType<typeof actor>) => ({
  identity: person.identity,
  label: person.label,
});
const unavailable = {
  __mockError: {
    code: "UNAVAILABLE",
    message: "This operation is not simulated in the session design demo.",
  },
};
const missing = {
  __mockError: { code: "INVALID_REQUEST", message: "Unknown session design fixture target." },
};

/** Keep the existing file/artifact examples, but never fall through into another session. */
function scopedCases(
  value: unknown,
  emptyCases: { match?: Record<string, unknown>; response: unknown }[],
) {
  const cases =
    value && typeof value === "object" && "cases" in value && Array.isArray(value.cases)
      ? value.cases
      : [{ match: { sessionKey: MAIN }, response: value }];
  return { cases: [...cases, ...emptyCases, { response: missing }] };
}

export function createSessionDesignScenario(
  base: ControlUiMockGatewayScenario,
  now: number,
  sourceFiles: { name: string; path: string; kind: string; content: string }[],
  sourceDiff: SessionsDiffResult,
  sourceArtifact: ArtifactSummary,
): ControlUiMockGatewayScenario {
  const minute = 60_000;
  const row = (key: string, title: string, age: number, options: Partial<GatewaySessionRow> = {}) =>
    sessionRow(key, title, now - age * minute, {
      agentId: "main",
      visibility: "shared",
      sharingRole: "admin",
      status: "done",
      contextTokens: 200_000,
      totalTokens: 0,
      totalTokensFresh: true,
      ...options,
    });
  // Different branch/PR snapshots require different checkouts, even within one project.
  const project = (checkout: string) => ({
    projectId: "session-design",
    spawnedCwd: checkout === "main" ? ROOT : `${ROOT}-${checkout}`,
    execCwd: checkout === "main" ? ROOT : `${ROOT}-${checkout}`,
    repository: {
      url: "https://github.com/synthetic/session-design",
      branch:
        checkout === "main"
          ? (sourceDiff.branch ?? "feature/session-diff-panel")
          : checkout === "handoff"
            ? HANDOFF_BRANCH
            : "main",
    },
  });
  const goal = {
    schemaVersion: 1 as const,
    id: "session-design-release-goal",
    objective:
      "Prepare a clear release handoff with reviewed changes, documentation, and a concise launch checklist.",
    status: "active" as const,
    createdAt: now - 24 * minute,
    updatedAt: now - minute,
    tokenStart: 0,
    tokenStartFresh: true,
    tokensUsed: 28_400,
    tokenBudget: 80_000,
    continuationTurns: 1,
  };
  const mobileWorkers = [
    "Navigation",
    "Composer",
    "Attachments",
    "Search",
    "Sessions",
    "Subagents",
    "Processes",
    "Terminal",
    "Files",
    "Sharing",
    "Details",
    "Accessibility",
    "Keyboard",
    "Localization",
    "Layout",
  ].map((area, index) => {
    const ordinal = String(index + 1).padStart(2, "0");
    const runId = `session-design-mobile-worker-${ordinal}-run`;
    return row(`agent:main:subagent:mobile-worker-${ordinal}`, `Review ${area.toLowerCase()}`, 0, {
      classification: "subagent",
      spawnedBy: MOBILE_SWARM,
      parentSessionKey: MOBILE_SWARM,
      createdActor: { type: "agent", id: "main", label: "Molty" },
      createdAt: now - (18 - index * 0.5) * minute,
      startedAt: now - (18 - index * 0.5) * minute,
      status: "running",
      hasActiveRun: true,
      activeRunIds: [runId],
      observerDigest: {
        runId,
        headline: `Reviewing ${area.toLowerCase()} in the mobile layout`,
        health: "on-track",
        revision: 1,
        updatedAt: now,
      },
      lastMessagePreview: `The synthetic ${area.toLowerCase()} review is in progress.`,
    });
  });
  const sessions = [
    row(MAIN, "Prepare the autumn release", 0, {
      ...project("main"),
      isMain: true,
      createdActor: avery,
      owner: { actor: avery },
      participants: [participant(mira), participant(riley)],
      participantCount: 2,
      hasActiveRun: true,
      activeRunIds: ["session-design-main-run"],
      status: "running",
      childSessions: [CHILD, "agent:main:subagent:release-links"],
      hasActiveSubagentRun: true,
      startedAt: now - 24 * minute,
      totalTokens: 28_400,
      inputTokens: 24_000,
      outputTokens: 4_400,
      goal,
      lastMessagePreview: "The release checklist is ready; documentation review is underway.",
    }),
    row("agent:main:reading-list", "Plan a quiet weekend", 8, {
      visibility: "suggest",
      createdActor: avery,
      owner: { actor: avery },
      lastMessagePreview: "Three books and a free afternoon. No project attached.",
    }),
    row("agent:main:unassigned", "Triage incoming ideas", 16, {
      lastMessagePreview: "A shared inbox, ready for someone to take ownership.",
    }),
    row(HANDOFF, "Hand off the launch checklist", 25, {
      ...project("handoff"),
      worktree: { id: HANDOFF_WORKTREE_ID, branch: HANDOFF_BRANCH, repoRoot: ROOT },
      createdActor: avery,
      owner: { actor: mira, assignedBy: avery, assignedAt: now - 20 * minute },
      participants: [participant(avery)],
      participantCount: 1,
      lastMessagePreview: "Avery started the work; Mira now owns the handoff.",
    }),
    row("agent:main:completed", "Finish the documentation refresh", 40, {
      ...project("completed"),
      visibility: "read-only",
      createdActor: riley,
      owner: { actor: riley },
      goal: {
        ...goal,
        id: "session-design-completed-goal",
        objective: "Refresh the release documentation and confirm every link.",
        status: "complete",
        createdAt: now - 95 * minute,
        tokensUsed: 12_600,
        completedAt: now - 40 * minute,
        updatedAt: now - 40 * minute,
      },
      totalTokens: 12_600,
      lastMessagePreview: "Documentation is complete. The goal remains available for review.",
    }),
    row("agent:main:production-export", "Review the release export", 4, {
      ...project("export"),
      // Observed synthetic placement only; no dispatch, reclaim, or remote execution.
      placement: {
        state: "active",
        generation: 1,
        createdAtMs: now - 10 * minute,
        updatedAtMs: now - minute,
        stateChangedAtMs: now - 9 * minute,
        providerId: "synthetic",
        profileId: "release-review",
        environmentId: WORKER_ENVIRONMENT_ID,
        activeOwnerEpoch: 1,
        workerBundleHash: "a".repeat(64),
        workspaceBaseManifestRef: "synthetic-release-base",
        remoteWorkspaceDir: `${ROOT}-export`,
        inference: "worker",
        machine: { class: "review-small", os: "linux", osLabel: "Linux", cpu: 2, memoryGb: 4 },
      },
      createdActor: avery,
      owner: { actor: avery },
      status: "running",
      hasActiveRun: true,
      activeRunIds: ["session-design-approval-run"],
      observerDigest: {
        headline: "Waiting for approval of the synthetic export",
        health: "waiting-on-user",
        revision: 1,
        runId: "session-design-approval-run",
        updatedAt: now - minute,
      },
    }),
    row("agent:main:blank-canvas", "Start with a blank canvas", 60, { visibility: "draft" }),
    row(MOBILE_QUEUE, "Mobile · queued messages", 0, {
      createdActor: avery,
      owner: { actor: avery },
      status: "running",
      hasActiveRun: true,
      activeRunIds: ["session-design-mobile-queue-run"],
      startedAt: now - 4 * minute,
      lastMessagePreview:
        "Reviewing the mobile checklist. Two follow-up messages are queued locally.",
    }),
    row(MOBILE_SWARM, "Mobile · 15 working subagents", 0, {
      createdActor: avery,
      owner: { actor: avery },
      startedAt: now - 20 * minute,
      endedAt: now - 10 * minute,
      runtimeMs: 10 * minute,
      childSessions: mobileWorkers.map((worker) => worker.key),
      hasActiveSubagentRun: true,
      lastMessagePreview:
        "The 15 synthetic reviews are underway. Waiting for the subagents to finish.",
    }),
    ...mobileWorkers,
    row("agent:main:subagent:release-links", "Verify release links", 12, {
      ...project("release-links"),
      classification: "subagent",
      spawnedBy: MAIN,
      parentSessionKey: MAIN,
      createdActor: { type: "agent", id: "main", label: "Molty" },
      startedAt: now - 18 * minute,
      endedAt: now - 12 * minute,
      runtimeMs: 6 * minute,
      lastMessagePreview: "All release document links have been checked.",
    }),
    row(CHILD, "Check the release documentation", 2, {
      ...project("release-review"),
      classification: "subagent",
      spawnedBy: MAIN,
      parentSessionKey: MAIN,
      createdActor: { type: "agent", id: "main", label: "Molty" },
      status: "running",
      hasActiveRun: true,
      activeRunIds: ["session-design-child-run"],
      startedAt: now - 5 * minute,
      observerDigest: {
        runId: "session-design-child-run",
        headline: "Checking examples and migration notes",
        health: "on-track",
        revision: 1,
        updatedAt: now - minute,
      },
    }),
  ];
  const history = (question: string, answer: string, at = now) => [
    {
      role: "user",
      content: question,
      timestamp: at - 3 * minute,
      __openclaw: { id: "design-question", seq: 1 },
    },
    {
      role: "assistant",
      content: answer,
      timestamp: at - 2 * minute,
      __openclaw: { id: "design-answer", seq: 2 },
    },
  ];
  const mainMessages = history(
    "Prepare the autumn release. Keep the checklist practical and ask for a documentation review.",
    "The release checklist is ready. Read the [release review](https://github.com/synthetic/session-design/pull/42). Review the changed files and generated preview in Files; the documentation review is underway.\n\n- Review the session rail changes\n- Confirm the launch notes\n- Hand off the release checklist",
  );
  const card: ProgressCard = {
    sessionKey: MAIN,
    revision: 1,
    updatedAt: now - minute,
    markdown:
      "The release changes and launch checklist are ready for review. Mira is checking the documentation examples and migration notes; the handoff stays open until that review is complete.",
    steps: [
      { step: "Inspect the release changes", status: "completed" },
      { step: "Prepare the launch checklist", status: "completed" },
      { step: "Review documentation with the subagent", status: "in_progress" },
      { step: "Hand off the release", status: "pending" },
    ],
  };
  const progressCards: Record<string, ProgressCard> = {
    [MAIN]: card,
    [HANDOFF]: {
      sessionKey: HANDOFF,
      revision: 1,
      updatedAt: now - 25 * minute,
      markdown:
        "Mira owns the next handoff. Review the launch notes in this worktree, then agree on the release window before sharing the checklist. No release has been published from this demo.",
    },
    "agent:main:completed": {
      sessionKey: "agent:main:completed",
      revision: 1,
      updatedAt: now - 40 * minute,
      markdown:
        "The documentation refresh is complete. The handoff document is available in Outputs.",
      steps: [
        { step: "Refresh the release documentation", status: "completed" },
        { step: "Check the documentation links", status: "completed" },
        { step: "Prepare the handoff document", status: "completed" },
      ],
    },
  };
  const profile: UserProfile = {
    id: "presence-avery",
    displayName: "Avery",
    avatarMime: null,
    mergedInto: null,
    createdAt: now - 30 * 24 * 60 * minute,
    updatedAt: now,
    emails: ["avery@example.com"],
    githubIdentity: null,
    hasAvatar: false,
  };
  const responses = { ...base.methodResponses };
  const others = sessions.filter((session) => session.key !== MAIN);
  const changedCheckouts = sessions.filter(
    (session) => session.key === MAIN || session.key === HANDOFF,
  );
  delete responses["sessions.list"];
  // The local file-byte plugin supplies the memory-only CAS writer.
  delete responses["sessions.files.set"];
  // Empty response delegates the receipt to the existing canonical mock session writer.
  responses["sessions.patch"] = {};
  // Sharing writes are installed with document-local native state below.
  responses["sessions.diff"] = {
    cases: [
      { match: { scope: "commit" }, response: missing },
      ...changedCheckouts.flatMap((session) => {
        const diff = {
          ...sourceDiff,
          sessionKey: session.key,
          root: session.spawnedCwd,
          branch: session.key === HANDOFF ? HANDOFF_BRANCH : sourceDiff.branch,
        };
        return [
          {
            match: { sessionKey: session.key, scope: "uncommitted" },
            response: {
              ...diff,
              baseRef: "HEAD",
              files: sourceDiff.files.filter((file) => file.status === "added"),
              additions: 3,
              deletions: 0,
            },
          },
          { match: { sessionKey: session.key }, response: diff },
        ];
      }),
      ...others
        .filter((session) => session.key !== HANDOFF)
        .map((session) => ({
          match: { sessionKey: session.key },
          response: {
            sessionKey: session.key,
            root: session.spawnedCwd,
            ...(session.spawnedCwd ? { branch: "main", baseRef: "main" } : {}),
            files: [],
            additions: 0,
            deletions: 0,
          },
        })),
      { response: missing },
    ],
  };
  responses["progressCard.get"] = {
    cases: [
      ...sessions
        .map((session) => ({
          match: { sessionKey: session.key },
          response: { card: progressCards[session.key] ?? null },
        }))
        .concat([{ match: { sessionKey: "main" }, response: { card } }]),
      { response: missing },
    ],
  };
  responses["users.self"] = { profile };
  responses["projects.list"] = {
    projects: [
      {
        id: "session-design",
        displayName: "Release workspace",
        repoRoot: ROOT,
        originUrl: "https://github.com/synthetic/session-design.git",
        source: "registered",
        agentId: "main",
      },
    ],
  } satisfies ProjectsListResult;
  responses["worktrees.list"] = {
    worktrees: [
      {
        id: HANDOFF_WORKTREE_ID,
        name: "launch-handoff",
        repoFingerprint: createHash("sha256").update(ROOT).digest("hex").slice(0, 16),
        repoRoot: ROOT,
        path: `${ROOT}-handoff`,
        branch: HANDOFF_BRANCH,
        baseRef: "main",
        ownerKind: "session",
        ownerId: HANDOFF,
        createdAt: now - 60 * minute,
        lastActiveAt: now - 25 * minute,
      },
    ],
  } satisfies WorktreesListResult;
  responses["agents.list"] = {
    agents: [
      {
        id: "main",
        name: "Molty",
        identity: { name: "Molty", emoji: "🦞" },
        workspace: "",
        workspaceGit: false,
      },
    ],
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
  };
  responses["agents.files.list"] = { agentId: "main", files: [], workspace: "" };
  responses["agents.files.get"] = missing;
  responses["sessions.catalog.list"] = { catalogs: [] };
  responses["sessions.catalog.read"] = missing;
  responses["sessions.search"] = unavailable;
  // Keep IDs stable while giving each session its own native automation state.
  // No delivery or scheduler execution is performed by this read-only snapshot.
  const automation = (
    id: string,
    name: string,
    sessionKey: string,
    schedule: CronJob["schedule"],
    enabled: boolean,
    state: CronJob["state"],
  ): CronJob => ({
    id,
    name,
    sessionKey,
    agentId: "main",
    enabled,
    createdAtMs: now - 24 * 60 * minute,
    updatedAtMs: now - 5 * minute,
    schedule,
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: name },
    delivery: { mode: "none" },
    state,
  });
  const jobs = [
    automation(
      "mock-cron-release-digest",
      "Publish release digest",
      MAIN,
      { kind: "cron", expr: "30 9 * * 1-5", tz: "America/New_York" },
      true,
      { nextRunAtMs: now + 30 * minute },
    ),
    automation(
      "mock-cron-inbox-triage",
      "Triage support inbox",
      "agent:main:unassigned",
      { kind: "every", everyMs: 15 * minute },
      false,
      {},
    ),
    automation(
      "mock-cron-calendar-sync",
      "Sync team calendar",
      "agent:main:reading-list",
      { kind: "cron", expr: "0 */6 * * *", tz: "America/New_York" },
      false,
      {
        lastRunAtMs: now - 5 * minute,
        lastRunStatus: "error",
        lastError:
          "Synthetic calendar sync failure. Reconnect the calendar before resuming this automation.",
        consecutiveErrors: 3,
        autoDisabled: {
          reason: "consecutive-failures",
          atMs: now - 5 * minute,
          consecutiveErrors: 3,
        },
        lastDeliveryStatus: "not-requested",
      },
    ),
  ];
  responses["cron.list"] = {
    cases: [
      ...cronListResponseFixture(
        sessions.map((session) => {
          const linkedJobs = jobs.filter((job) => job.sessionKey === session.key);
          return {
            match: { sessionKey: session.key },
            response: {
              jobs: linkedJobs,
              total: linkedJobs.length,
              offset: 0,
              limit: 50,
              hasMore: false,
              nextOffset: null,
              snapshotRevision: "session-design",
            },
          };
        }),
      ).cases,
      { response: unavailable },
    ],
  };
  responses["cron.get"] = {
    cases: [
      ...jobs.flatMap((job) => [
        { match: { id: job.id }, response: job },
        { match: { jobId: job.id }, response: job },
      ]),
      { response: missing },
    ],
  };
  // The request handler below delegates filtering, ordering and pagination to the native owner.
  responses["cron.runs"] = {
    entries: [],
    total: 0,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
  responses["cron.history"] = unavailable;
  responses["cron.status"] = {
    enabled: true,
    triggersEnabled: true,
    jobs: jobs.length,
    nextWakeAtMs: now + 30 * minute,
  };
  for (const method of [
    "cron.add",
    "cron.update",
    "cron.remove",
    "cron.run",
    "progressCard.refresh",
    "sessions.goal.update",
    "sessions.goal.clear",
    "sessions.compact",
    "sessions.dispatch",
    "sessions.reclaim",
    "sessions.move",
    "sessions.usage.timeseries",
    "sessions.usage.logs",
    "browser.request",
    "session.discussion.open",
    "usage.cost",
  ]) {
    responses[method] = unavailable;
  }
  const samples = sessionDesignFileSamples();
  const files: SessionFileEntry[] = [
    ...sourceFiles,
    {
      name: "README.md",
      path: "README.md",
      kind: "modified",
      content:
        "# Autumn release\n\nA synthetic workspace for reviewing the release handoff.\n\n## Checklist\n\n- [x] Prepare the implementation\n- [x] Check documentation links\n- [ ] Finish documentation review\n\n| Owner | Work | Status |\n| --- | --- | --- |\n| Mira | Documentation | In review |\n| Riley | Release links | Done |\n\n```sh\npnpm docs:list\n```\n\n> Review the changed files before sharing.\n\n[Local release notes](https://example.invalid/release) are synthetic.\n\nReview the generated preview in Outputs before the handoff.\n",
    },
  ].map((file) => ({
    name: file.name,
    path: file.path,
    workspacePath: file.path,
    kind: file.kind === "read" ? "read" : "modified",
    missing: false,
    previewKind: "text",
    contentEncoding: "utf8",
    content: file.content,
    size: Buffer.byteLength(file.content),
    hash: createHash("sha256").update(file.content).digest("hex"),
    updatedAtMs: now - minute,
  }));
  files.push(
    ...samples.map((sample): SessionFileEntry => ({
      name: sample.name,
      path: `examples/${sample.name}`,
      workspacePath: `examples/${sample.name}`,
      kind: "read",
      missing: false,
      size: sample.bytes.length,
      hash: createHash("sha256").update(sample.bytes).digest("hex"),
      mimeType: sample.mimeType,
      previewKind: sample.previewKind,
      contentEncoding: sample.previewKind === "text" ? "utf8" : "base64",
      content: sample.bytes.toString(sample.previewKind === "text" ? "utf8" : "base64"),
      updatedAtMs: now - minute,
    })),
  );
  files.push({
    name: "missing.txt",
    path: "examples/missing.txt",
    workspacePath: "examples/missing.txt",
    kind: "read",
    missing: true,
  });
  const fileFailures: Record<
    string,
    { __mockError: { code: string; message: string; details?: Record<string, unknown> } }
  > = {
    "access-denied.txt": {
      __mockError: {
        code: "INVALID_REQUEST",
        message: "session file not found",
        details: {
          type: "session_file_not_found",
          reason: "outside_session_boundary",
          path: "examples/access-denied.txt",
        },
      },
    },
    "workspace-unavailable.txt": {
      __mockError: { code: "UNAVAILABLE", message: "The session workspace owner is unavailable" },
    },
  };
  files.push(
    ...Object.keys(fileFailures).map((name): SessionFileEntry => ({
      name,
      path: `examples/${name}`,
      workspacePath: `examples/${name}`,
      kind: "read",
      missing: false,
    })),
  );
  responses["sessions.files.get"] = {
    cases: [
      ...changedCheckouts.flatMap((session) =>
        files.flatMap((file) =>
          [file.path, `${session.spawnedCwd}/${file.path}`].map((path) => ({
            match: { sessionKey: session.key, path },
            response: fileFailures[file.name] ?? {
              sessionKey: session.key,
              root: session.spawnedCwd,
              file,
            },
          })),
        ),
      ),
      { response: missing },
    ],
  };
  responses["sessions.files.download"] = {
    cases: [
      ...changedCheckouts.flatMap((session) =>
        files
          .filter((file) => !file.missing && !fileFailures[file.name])
          .flatMap((file) =>
            [file.path, `${session.spawnedCwd}/${file.path}`].map((path) => ({
              match: { sessionKey: session.key, path },
              response: {
                filename: file.name,
                mimeType: file.mimeType ?? "text/plain",
                url: sessionDesignFileDownloadUrl(session.key, file),
                expiresAt: new Date(now + 86_400_000).toISOString(),
              },
            })),
          ),
      ),
      { response: missing },
    ],
  };
  const directories = new Set([""]);
  for (const file of files) {
    const parts = file.path.split("/");
    for (let count = 1; count < parts.length; count++) {
      directories.add(parts.slice(0, count).join("/"));
    }
  }
  const fileCases = [...directories].map((directory) => {
    const entries = new Map<string, SessionFileBrowserEntry>();
    const prefix = directory ? `${directory}/` : "";
    for (const file of files) {
      if (!file.path.startsWith(prefix)) {
        continue;
      }
      const suffix = file.path.slice(prefix.length);
      const name = suffix.split("/")[0] ?? suffix;
      entries.set(
        name,
        suffix.includes("/")
          ? { name, path: `${prefix}${name}`, kind: "directory" }
          : { name, path: file.path, kind: "file", size: file.size, sessionKind: file.kind },
      );
    }
    return {
      match: { sessionKey: MAIN, path: directory },
      response: {
        sessionKey: MAIN,
        root: ROOT,
        gitCheckout: true,
        files: files.map(({ content: _content, ...file }) => file),
        browser: {
          path: directory,
          ...(directory ? { parentPath: directory.split("/").slice(0, -1).join("/") } : {}),
          entries: [...entries.values()],
        },
      },
    };
  });
  responses["sessions.files.list"] = {
    cases: [
      ...changedCheckouts.flatMap((session) => {
        const directoryCases = [];
        for (const entry of fileCases) {
          directoryCases.push({
            match: { ...entry.match, sessionKey: session.key },
            response: { ...entry.response, sessionKey: session.key, root: session.spawnedCwd },
          });
        }
        directoryCases.push({
          match: { sessionKey: session.key },
          response: {
            ...fileCases.find((entry) => entry.match.path === "")!.response,
            sessionKey: session.key,
            root: session.spawnedCwd,
          },
        });
        return directoryCases;
      }),
      ...others
        .filter((session) => session.key !== HANDOFF)
        .map((session) => ({
          match: { sessionKey: session.key },
          response: {
            sessionKey: session.key,
            files: [],
            browser: { path: "", entries: [] },
            ...(session.spawnedCwd ? { root: session.spawnedCwd, gitCheckout: true } : {}),
          },
        })),
      { response: missing },
    ],
  };
  const document =
    "# Release handoff\n\nThis handoff collects the launch checklist, documentation links, and review notes.\n\n- Review the changes\n- Confirm the release window\n- Share the handoff with Mira\n";
  const handoffArtifact = (sessionKey: string): ArtifactSummary => ({
    id: `handoff-${sessionKey.split(":").at(-1)}`,
    title: "release-handoff.md",
    type: "document",
    mimeType: "text/markdown",
    sizeBytes: Buffer.byteLength(document),
    sessionKey,
    source: "session-transcript",
    download: { mode: "bytes" },
  });
  const mainArtifact = handoffArtifact(MAIN),
    completedArtifact = handoffArtifact("agent:main:completed");
  const fileArtifacts = samples
    .filter((sample) =>
      [
        "preview.png",
        "preview.svg",
        "review.pdf",
        "example.html",
        "example.csv",
        "example.json",
      ].includes(sample.name),
    )
    .map((sample) => ({
      sample,
      artifact: {
        id: `session-design-${sample.name}`,
        title: sample.name,
        type: sample.mimeType.startsWith("image/") ? "image" : "document",
        mimeType: sample.mimeType,
        sizeBytes: sample.bytes.length,
        sessionKey: MAIN,
        source: "session-transcript",
        download: { mode: "bytes" as const },
      },
    }));
  const expiredArtifact: ArtifactSummary = {
    id: "session-design-expired-report",
    title: "expired-report.pdf",
    type: "document",
    mimeType: "application/pdf",
    sessionKey: MAIN,
    source: "session-transcript",
    download: { mode: "url" },
  };
  responses["artifacts.list"] = {
    cases: [
      ...sessions.map((session) => ({
        match: { sessionKey: session.key },
        response: {
          artifacts:
            session.key === MAIN
              ? [
                  { ...sourceArtifact, sessionKey: MAIN },
                  mainArtifact,
                  ...fileArtifacts.map((entry) => entry.artifact),
                  expiredArtifact,
                ]
              : session.key === "agent:main:completed"
                ? [completedArtifact]
                : [],
        },
      })),
      { response: missing },
    ],
  };
  responses["artifacts.download"] = scopedCases(base.methodResponses?.["artifacts.download"], [
    {
      match: { sessionKey: MAIN, artifactId: expiredArtifact.id },
      response: {
        artifact: expiredArtifact,
        url: "/api/artifacts/download/session-design/expired",
        expiresAt: new Date(now - minute).toISOString(),
      },
    },
    ...fileArtifacts.map(({ sample, artifact }) => ({
      match: { sessionKey: MAIN, artifactId: artifact.id },
      response: { artifact, encoding: "base64", data: sample.bytes.toString("base64") },
    })),
    ...[mainArtifact, completedArtifact].map((artifact) => ({
      match: { sessionKey: artifact.sessionKey, artifactId: artifact.id },
      response: { artifact, encoding: "base64", data: Buffer.from(document).toString("base64") },
    })),
  ]);

  responses["artifacts.get"] = {
    cases: [
      ...[
        { ...sourceArtifact, sessionKey: MAIN },
        mainArtifact,
        completedArtifact,
        expiredArtifact,
        ...fileArtifacts.map((entry) => entry.artifact),
      ].map((artifact) => ({
        match: { sessionKey: artifact.sessionKey, artifactId: artifact.id },
        response: { artifact },
      })),
      { response: missing },
    ],
  };
  const date = new Date(now).toISOString().slice(0, 10);
  responses["sessions.usage"] = {
    cases: [
      ...sessions.map((session) => {
        const report: SessionSystemPromptReport = {
          source: "estimate",
          generatedAt: now,
          sessionId: session.sessionId,
          sessionKey: session.key,
          provider: "openai",
          model: "gpt-5-mini",
          ...(session.spawnedCwd ? { workspaceDir: session.spawnedCwd } : {}),
          systemPrompt: {
            chars: 6400,
            projectContextChars: session.spawnedCwd ? 1200 : 0,
            nonProjectContextChars: session.spawnedCwd ? 5200 : 6400,
          },
          injectedWorkspaceFiles: [],
          skills: { promptChars: 800, entries: [{ name: "Release checklist", blockChars: 800 }] },
          tools: {
            listChars: 600,
            schemaChars: 1400,
            entries: [{ name: "read", summaryChars: 120, schemaChars: 360 }],
          },
        };
        const total = typeof session.totalTokens === "number" ? session.totalTokens : 0;
        const response: SessionsUsageResult = {
          updatedAt: now,
          startDate: date,
          endDate: date,
          sessions: [
            {
              key: session.key,
              sessionId: session.sessionId,
              agentId: "main",
              model: "gpt-5-mini",
              modelProvider: "openai",
              usage: null,
              contextWeight: report,
            },
          ],
          totals: {
            input: session.key === MAIN ? 24_000 : total,
            output: session.key === MAIN ? 4_400 : 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: total,
            totalCost: 0,
            inputCost: 0,
            outputCost: 0,
            cacheReadCost: 0,
            cacheWriteCost: 0,
            missingCostEntries: 1,
          },
          aggregates: {
            messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
            tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
            byModel: [],
            byProvider: [],
            byAgent: [],
            byChannel: [],
            daily: [],
          },
        };
        return { match: { key: session.key }, response };
      }),
      { response: missing },
    ],
  };
  // Passive plugin content is synthetic; no external GitHub request is made.
  const reviewUrl = "https://github.com/synthetic/session-design/pull/42";
  const readers: ControlUiLinkReaderDescriptor[] = [
    {
      pluginId: "github",
      id: "references",
      label: "GitHub",
      icon: "github",
      linkReader: {
        hosts: ["github.com"],
        pathPattern: "^/synthetic/session-design/pull/42$",
        detailMethod: "github.detail",
        previewMethod: "github.preview",
      },
    },
  ];
  const review: ControlUiLinkReaderDocument = {
    url: reviewUrl,
    title: "Polish the release session workspace",
    subtitle: "synthetic/session-design · #42 · Demo",
    author: "mira-demo",
    badge: { label: "Open", tone: "positive" },
    createdAt: new Date(now - 40 * minute).toISOString(),
    body: "## Release review\n\nThis is a synthetic, read-only review. Keep the conversation visible while checking the handoff.\n\n- Inspect the changed files\n- Confirm the documentation checklist\n- Preserve unfinished drafts when switching tabs",
    files: sourceDiff.files.map((file) => ({
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch,
    })),
    filesTotal: sourceDiff.files.length,
    comments: [
      {
        id: "review-note",
        url: `${reviewUrl}#review-note`,
        author: "riley-demo",
        createdAt: new Date(now - 12 * minute).toISOString(),
        body: "The release links are checked. Documentation review is the remaining handoff item.",
      },
    ],
    commentsTotal: 1,
  };
  for (const method of ["github.detail", "github.preview"]) {
    responses[method] = {
      cases: [{ match: { url: reviewUrl }, response: review }, { response: missing }],
    };
  }
  const environment: EnvironmentSummary = {
    id: "gateway",
    type: "gateway",
    label: "Synthetic demo desktop",
    status: "available",
    desktop: true,
  };
  const workerEnvironment: EnvironmentSummary = {
    id: WORKER_ENVIRONMENT_ID,
    type: "worker",
    label: "Synthetic release worker",
    status: "available",
    platform: "linux",
    desktop: false,
    worker: {
      providerId: "synthetic",
      profileId: "release-review",
      state: "attached",
      ageMs: 10 * minute,
      attachedSessionIds: [
        sessions.find((session) => session.key === "agent:main:production-export")!.sessionId!,
      ],
      tunnelStatus: "connected",
      desktop: false,
    },
  };
  responses["environments.list"] = { environments: [environment, workerEnvironment] };
  responses["environments.status"] = {
    cases: [
      { match: { environmentId: "gateway" }, response: environment },
      { match: { environmentId: WORKER_ENVIRONMENT_ID }, response: workerEnvironment },
      { response: missing },
    ],
  };
  // Only the Gateway desktop has a local synthetic RFB transport. The worker is metadata-only.
  // The browser initializer supplies the current public origin, including forwarded ports.
  responses["portal.list"] = { portals: [] } satisfies PortalListResult;
  responses["session.discussion.info"] = {
    cases: [
      { match: { sessionKey: MAIN }, response: { state: "open" } },
      ...others.map((session) => ({
        match: { sessionKey: session.key },
        response: { state: "none" },
      })),
      { response: missing },
    ],
  };
  // This HTML is a local, passive document; no grant or remote application is impersonated.
  const boardDocument = `<!doctype html><meta charset="utf-8"><style>
    :root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:24px;line-height:1.5}
    h1{font-size:20px}li{margin-block:8px}small{opacity:.65}
    </style><small>SESSION DESIGN · SYNTHETIC DEMO</small><h1>Autumn release handoff</h1>
    <ul><li>Implementation prepared</li><li>Release links checked</li><li>Documentation review in progress</li></ul>
    <p>Mira owns the documentation handoff. Review the changed files and generated preview before sharing.</p>`;
  const board: BoardSnapshot = {
    sessionKey: MAIN,
    revision: 1,
    tabs: [{ tabId: "handoff", title: "Release handoff", position: 0, chatDock: "right" }],
    widgets: [
      {
        name: "checklist",
        tabId: "handoff",
        title: "Release checklist",
        contentKind: "html",
        sizeW: 12,
        sizeH: 6,
        position: 0,
        grantState: "none",
        revision: 1,
        frameUrl: `data:text/html;charset=utf-8,${encodeURIComponent(boardDocument)}`,
      },
    ],
  };
  responses["board.get"] = {
    cases: [
      { match: { sessionKey: MAIN }, response: board },
      ...others.map((session) => ({
        match: { sessionKey: session.key },
        response: {
          sessionKey: session.key,
          revision: 0,
          tabs: [],
          widgets: [],
        },
      })),
      { response: missing },
    ],
  };
  for (const method of ["board.update", "board.widget.put", "board.widget.grant", "portal.close"]) {
    responses[method] = unavailable;
  }
  return {
    ...base,
    sessions,
    sessionKey: MAIN,
    mainSessionKey: MAIN,
    workspace: "",
    workspaceGit: false,
    terminalEnabled: true,
    controlUiLinkReaders: readers,
    sessionGroups: ["Design", "Documentation", "Engineering", "Release", "Research"],
    sessionReactions: {},
    inFlightRun: null,
    repeatingSessionEvents: { events: [] },
    methodResponses: responses,
    historyMessages: mainMessages,
    sessionTranscripts: Object.fromEntries(
      sessions.map((session) => [
        session.key,
        {
          messages:
            session.key === MAIN
              ? mainMessages
              : session.key === MOBILE_QUEUE
                ? history(
                    "Review the mobile checklist before taking my follow-up messages.",
                    "I’ll work through the checklist first.",
                  )
                : session.key === MOBILE_SWARM
                  ? history(
                      "Review the 15 mobile areas in parallel.",
                      String(session.lastMessagePreview),
                      now - 8 * minute,
                    )
                  : session.key.endsWith("blank-canvas")
                    ? []
                    : history(
                        session.label,
                        session.lastMessagePreview ?? "This synthetic session is ready for review.",
                        typeof session.updatedAt === "number" ? session.updatedAt : now,
                      ),
          inFlightRun: session.hasActiveRun
            ? {
                runId: Array.isArray(session.activeRunIds) ? String(session.activeRunIds[0]) : "",
                startedAt:
                  typeof session.startedAt === "number" ? session.startedAt : now - 5 * minute,
                ...(session.key === MAIN ? { plan: { steps: card.steps } } : {}),
                ...(session.key === MOBILE_QUEUE || session.parentSessionKey === MOBILE_SWARM
                  ? {
                      text:
                        session.key === MOBILE_QUEUE
                          ? "Checking the mobile checklist before taking the queued follow-ups."
                          : session.lastMessagePreview,
                    }
                  : {}),
              }
            : null,
        },
      ]),
    ),
    presenceUsers: [
      {
        self: true,
        id: profile.id,
        identity: { type: "profile", id: profile.id },
        name: "Avery",
        watchedSessions: [MAIN],
      },
      {
        id: "profile-mira",
        identity: { type: "profile", id: "profile-mira" },
        name: "Mira",
        watchedSessions: [MAIN, "agent:main:handoff"],
        deviceFamily: "Mac",
        lastInputSeconds: 12,
      },
      {
        id: "profile-riley",
        identity: { type: "profile", id: "profile-riley" },
        name: "Riley",
        watchedSessions: [MAIN],
        deviceFamily: "iPhone",
        lastInputSeconds: 30,
      },
    ],
    featureMethods: [
      ...new Set([
        ...(base.featureMethods ?? []),
        "canvas.document.preview",
        "sessions.files.assets",
        "desktop.observe",
        "desktop.release",
        "environments.status",
        "portal.list",
        "session.discussion.info",
        "github.detail",
        "github.preview",
        "sessions.github.options",
        "sessions.github.publish",
        "sessions.github.status",
        "board.get",
        "sessions.companion.ask",
        "sessions.companion.state",
        "sessions.companion.reset",
        "users.mentionable",
        "session.visibility.set",
        "session.members.listEvidence",
        "session.publicShare.set",
        "session.members.add",
        "session.members.remove",
        "projects.list",
        "worktrees.list",
        "sessions.files.download",
        "sessions.files.set",
        "sessions.usage",
        "controlUi.sessionPullRequests.subscribe",
      ]),
    ].filter((method) => responses[method] !== unavailable),
    featureEvents: [
      ...new Set([
        ...(base.featureEvents ?? []),
        "controlUi.sessionPullRequests.changed",
        "sessions.changed",
        "session.sharing",
      ]),
    ],
  };
}

function installSessionDesign(
  snapshots: Record<string, ControlUiSessionPullRequestSnapshot>,
  fileListings: Record<string, Record<string, SessionsFilesListResult>>,
  timestamp: number,
  portalPath: string,
  sharing: Record<string, { sessionId: string; result: SessionMembersListEvidenceResult }>,
  sandbox: SessionDesignSandbox,
  previewMaxBytes: number,
): void {
  const gateway = (window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
    .openclawControlUiE2eGateway;
  if (!gateway) {
    throw new Error("Session design fixtures require the mock Gateway");
  }
  gateway.setRequestHandler("cron.runs", ({ params, respond }) => {
    void (async () => {
      try {
        const response = await fetch("/__fixtures/session-design/cron-runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });
        respond(await response.json());
      } catch {
        respond({
          __mockError: {
            code: "UNAVAILABLE",
            message: "Synthetic automation history is unavailable.",
          },
        });
      }
    })();
  });
  // Handoff only: exercise native publication and recovery without any external effect.
  const publications = new Map<string, SessionGitHubStatusResult>();
  let latestPublication: SessionGitHubStatusResult | null = null;
  const publisher = { source: "system-configured" as const, accountId: 1, login: "synthetic-demo" };
  for (const method of [
    "sessions.github.options",
    "sessions.github.publish",
    "sessions.github.status",
  ]) {
    gateway.setRequestHandler(method, ({ params, respond }) => {
      const target = params as Pick<SessionGitHubPublishParams, "sessionKey" | "agentId">;
      const handoff =
        target.sessionKey === "agent:main:handoff" &&
        (!target.agentId || target.agentId === "main");
      if (method === "sessions.github.options") {
        respond({
          personal: null,
          shared: handoff ? publisher : null,
          pendingPersonal: null,
          latestShared: handoff ? latestPublication : null,
        } satisfies SessionGitHubOptionsResult);
        return;
      }
      if (!handoff) {
        respond({
          __mockError: {
            code: "INVALID_REQUEST",
            message: "Only the synthetic handoff supports publication.",
          },
        });
        return;
      }
      if (method === "sessions.github.publish") {
        const input = params as SessionGitHubPublishParams;
        latestPublication = publications.get(input.idempotencyKey) ?? {
          result: {
            requestId: input.idempotencyKey,
            publisher,
            status: "requested",
            message:
              "Synthetic publication requested. Check status to review the simulated outcome; nothing is sent to GitHub.",
          },
          confirmation: null,
        };
        publications.set(input.idempotencyKey, latestPublication);
        respond(latestPublication.result);
        return;
      }
      const input = params as SessionGitHubStatusParams;
      const publication = publications.get(input.requestId);
      if (!publication) {
        respond({
          __mockError: { code: "INVALID_REQUEST", message: "Unknown synthetic publication." },
        });
        return;
      }
      publication.result = {
        requestId: input.requestId,
        publisher,
        status: "failed",
        code: "unavailable",
        message: "Synthetic publication stopped before any external action.",
        nextAction:
          "This demo does not publish to GitHub. Start a new action to review the flow again.",
      };
      respond(publication);
    });
  }
  gateway.setRequestHandler("canvas.document.preview", ({ params, respond }) => {
    const input = params as CanvasDocumentPreviewParams;
    if (
      typeof input.html !== "string" ||
      new TextEncoder().encode(input.html).byteLength > previewMaxBytes
    ) {
      respond({ __mockError: { code: "INVALID_REQUEST", message: "Invalid HTML preview." } });
      return;
    }
    respond({ html: input.html, ...sandbox } satisfies CanvasDocumentViewResult);
  });
  gateway.setRequestHandler("sessions.files.assets", ({ params, respond }) => {
    const input = params as SessionsFilesAssetsParams;
    const files = fileListings[input.sessionKey]?.[""]?.files;
    if (
      (input.agentId && input.agentId !== "main") ||
      !files?.some((file) => file.path === input.path)
    ) {
      respond({
        __mockError: { code: "INVALID_REQUEST", message: "Unknown session design file." },
      });
      return;
    }
    // Current HTML fixtures are self-contained. Never fetch unknown relative/external assets.
    respond({
      assets: input.refs.map((ref) => ({ ref, error: "not_found" })),
    } satisfies SessionsFilesAssetsResult);
  });
  const publicUrl = new URL(portalPath, window.location.origin);
  const port = Number(publicUrl.port || (publicUrl.protocol === "https:" ? 443 : 80));
  const tokenQuery = "openclaw_portal=session-design-local";
  const portal: PortalListResult = {
    portals: [
      {
        id: "release-preview",
        title: "Release readiness",
        description: "Release checklist and documentation handoff.",
        port,
        listenPort: port,
        publicUrl: publicUrl.href,
        url: `${publicUrl.href}?${tokenQuery}`,
        tokenQuery,
        createdAtMs: timestamp - 20 * 60_000,
      },
    ],
  };
  gateway.setRequestHandler("portal.list", ({ respond }) => respond(portal));
  for (const method of ["desktop.observe", "desktop.release"]) {
    gateway.setRequestHandler(method, ({ params, respond }) => {
      void (async () => {
        try {
          const response = await fetch(`/__fixtures/session-design/desktop?method=${method}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
          });
          respond(await response.json());
        } catch {
          respond({
            __mockError: {
              code: "UNAVAILABLE",
              message: "The local synthetic desktop endpoint is unavailable.",
            },
          });
        }
      })();
    });
  }

  // Document-local grants model the native read/write contract, not a public web service.
  // Reload resets the demo; repeated enable retains a grant, revoke + enable creates a new one.
  let shareSequence = 0;
  for (const method of [
    "session.members.listEvidence",
    "session.visibility.set",
    "session.publicShare.set",
    "session.members.add",
    "session.members.remove",
  ]) {
    gateway.setRequestHandler(method, ({ params, respond, emit }) => {
      const input = params as
        | SessionMembersListParams
        | SessionPublicShareSetParams
        | SessionMemberAddParams
        | SessionVisibilitySetParams;
      const key = input.sessionKey === "main" ? "agent:main:main" : input.sessionKey;
      const entry = Object.hasOwn(sharing, key) ? sharing[key] : undefined;
      if (!entry || (input.agentId && input.agentId !== "main")) {
        respond({
          __mockError: {
            code: "INVALID_REQUEST",
            message: "Unknown session design sharing target.",
          },
        });
        return;
      }
      const row = gateway.getSessionRow(key);
      if (row.sessionId !== entry.sessionId) {
        respond({
          __mockError: {
            code: "INVALID_REQUEST",
            message: "Session changed; reopen the demo before sharing.",
          },
        });
        return;
      }
      if (method === "session.members.listEvidence") {
        respond(entry.result);
        return;
      }
      if (row.sharingRole !== "admin" && row.sharingRole !== "owner") {
        respond({
          __mockError: {
            code: "INVALID_REQUEST",
            message: "This session cannot be managed by the demo viewer.",
          },
        });
        return;
      }
      if (method === "session.visibility.set") {
        if (
          !("visibility" in input) ||
          !entry.result.allowedVisibilities?.includes(input.visibility)
        ) {
          respond({
            __mockError: {
              code: "INVALID_REQUEST",
              message: "This access mode is not available in the demo.",
            },
          });
          return;
        }
        const visibility = input.visibility;
        const result = gateway.setSessionVisibility(key, entry.sessionId, visibility);
        respond(result);
        if ("__mockError" in result) {
          return;
        }
        emit("session.sharing", {
          action: "visibility",
          sessionKey: key,
          agentId: "main",
          visibility,
          actor: { type: "human", id: "presence-avery", label: "Avery" },
          ts: Date.now(),
        });
        emit("sessions.changed", {
          reason: "sharing",
          sessionKey: key,
          agentId: "main",
          ts: Date.now(),
        });
        return;
      }
      if (method === "session.members.add" || method === "session.members.remove") {
        if (
          !("identityId" in input) ||
          !entry.result.identities.some((person) => person.id === input.identityId) ||
          input.identityId === entry.result.owner?.id
        ) {
          respond({
            __mockError: {
              code: "INVALID_REQUEST",
              message: "Unknown or non-editable session design member.",
            },
          });
          return;
        }
        const present = entry.result.members.some(
          (member) => member.identityId === input.identityId,
        );
        const added = method === "session.members.add";
        if (added && !present) {
          entry.result.members.push({
            identityId: input.identityId,
            addedBy: "presence-avery",
            addedAt: Date.now(),
          });
        } else if (!added && present) {
          entry.result.members = entry.result.members.filter(
            (member) => member.identityId !== input.identityId,
          );
        }
        respond({
          ok: true,
          sessionKey: key,
          identityId: input.identityId,
        } satisfies SessionMemberMutationResult);
        if (added !== present) {
          emit("session.sharing", {
            action: added ? "member-added" : "member-removed",
            sessionKey: key,
            agentId: "main",
            identityId: input.identityId,
            actor: { type: "human", id: "presence-avery", label: "Avery" },
            ts: Date.now(),
          });
          emit("sessions.changed", {
            reason: "sharing",
            sessionKey: key,
            agentId: "main",
            ts: Date.now(),
          });
        }
        return;
      }
      if (
        !("enabled" in input) ||
        typeof input.enabled !== "boolean" ||
        input.expectedSessionId !== row.sessionId
      ) {
        respond({
          __mockError: {
            code: "INVALID_REQUEST",
            message: "Session changed; reopen sharing before publishing.",
          },
        });
        return;
      }
      const previous = entry.result.publicShare;
      if (input.enabled) {
        entry.result.publicShare ??= {
          token: `v1.session_design_${encodeURIComponent(key).replaceAll("%", "_")}_${++shareSequence}`,
          createdAt: Date.now(),
        };
      } else {
        delete entry.result.publicShare;
      }
      respond({
        ok: true,
        sessionKey: key,
        ...(entry.result.publicShare ? { publicShare: entry.result.publicShare } : {}),
      } satisfies SessionPublicShareSetResult);
      if (previous !== entry.result.publicShare) {
        emit("sessions.changed", {
          reason: "sharing",
          sessionKey: key,
          agentId: "main",
          ts: Date.now(),
        });
      }
    });
  }
  let companionTimestamp = timestamp;
  const threads = new Map<string, SessionCompanionExchange[]>();
  for (const method of [
    "sessions.companion.ask",
    "sessions.companion.state",
    "sessions.companion.reset",
  ]) {
    gateway.setRequestHandler(method, ({ params, respond }) => {
      const input = params as SessionsCompanionAskParams;
      if (
        !Object.hasOwn(snapshots, input.sessionKey) ||
        (input.agentId && input.agentId !== "main")
      ) {
        respond({
          __mockError: { code: "INVALID_REQUEST", message: "Unknown session design companion." },
        });
        return;
      }
      const key = JSON.stringify([input.sessionKey, input.agentId ?? "main"]);
      if (method === "sessions.companion.reset") {
        threads.delete(key);
        respond({ ok: true });
      } else if (method === "sessions.companion.state") {
        respond({ exchanges: threads.get(key) ?? [] });
      } else {
        const result = {
          answer:
            input.sessionKey === "agent:main:main"
              ? "The launch checklist is ready. Documentation is still being reviewed; inspect the changed files before the handoff."
              : "This synthetic session is ready for review. Its notes remain separate from the release session.",
          ts: companionTimestamp++,
        };
        threads.set(
          key,
          [...(threads.get(key) ?? []), { question: input.question, ...result }].slice(-24),
        );
        respond(result);
      }
    });
  }
  for (const method of [
    "sessions.files.get",
    "sessions.files.set",
    "sessions.files.list",
    "sessions.files.download",
  ]) {
    gateway.setRequestHandler(method, ({ params, respond }) => {
      void (async () => {
        try {
          const response = await fetch(`/__fixtures/session-design/files?method=${method}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
          });
          respond(await response.json());
        } catch {
          respond({
            __mockError: {
              code: "UNAVAILABLE",
              message: "The local synthetic file store is unavailable.",
            },
          });
        }
      })();
    });
  }
  gateway.setRequestHandler(
    "controlUi.sessionPullRequests.subscribe",
    ({ params, respond, emit }) => {
      const { sessionKeys } = params as { sessionKeys: string[] };
      if (sessionKeys.some((key) => !Object.hasOwn(snapshots, key))) {
        respond({
          __mockError: { code: "INVALID_REQUEST", message: "Unknown session design PR target." },
        });
        return;
      }
      respond({ subscribed: sessionKeys.length > 0 });
      emit("controlUi.sessionPullRequests.changed", {
        sessions: Object.fromEntries(
          Object.entries(snapshots).filter(([key]) => sessionKeys.includes(key)),
        ),
      } satisfies ControlUiSessionPullRequestsChanged);
    },
  );
}

/** Seed the client-owned outbox once per mock tab; edits/removals survive reload. */
async function seedSessionDesignMobileQueue(sessionKey: string): Promise<void> {
  const storeModulePath = "/src/lib/chat/outbox-store.ts";
  const payloadModulePath = "/src/lib/chat/outbox-payload-store.runtime.ts";
  const [storeOwner, payloadOwner]: [
    typeof import("../ui/src/lib/chat/outbox-store.ts"),
    typeof import("../ui/src/lib/chat/outbox-payload-store.runtime.ts"),
  ] = await Promise.all([
    import(/* @vite-ignore */ storeModulePath),
    import(/* @vite-ignore */ payloadModulePath),
  ]);
  const auth = (
    window as Window & {
      __OPENCLAW_NATIVE_CONTROL_AUTH__?: { gatewayUrl: string };
    }
  )["__OPENCLAW_NATIVE_CONTROL_AUTH__"];
  if (!auth) {
    throw new Error("Session design queue requires the same-origin mock Gateway");
  }
  // This is the recovery scope emitted by the existing mock connect handshake.
  const host = {
    settings: { gatewayUrl: auth.gatewayUrl },
    connected: true,
    client: { recoveryScope: "e2e-recovery-scope", recoveryScopeReady: true },
  };
  const target = storeOwner.storageTargetForComposer(host);
  const seedKey = `session-design:mobile-queue:seeded:${target.key}`;
  if (sessionStorage.getItem(seedKey)) {
    return;
  }
  const store = storeOwner.readStoredOutboxStore(sessionStorage, target);
  const scopeKey = storeOwner.storedChatOutboxScopeKey({ sessionKey, agentId: "main" });
  if (!store.sessions[scopeKey]) {
    const now = Date.now();
    store.sessions[scopeKey] = {
      updatedAt: now,
      queue: [
        "Check the narrow-screen attachment controls next.",
        "Then summarize the mobile navigation findings.",
      ].map((text, index) => ({
        id: `session-design-mobile-queued-${index + 1}`,
        text,
        createdAt: now - (2 - index) * 30_000,
        sessionKey,
        agentId: "main",
        storageScope: payloadOwner.outboxStorageScope(host),
        sendState: "waiting-idle",
        sendAttempts: 0,
      })),
    };
    storeOwner.writeStoredOutboxStore(sessionStorage, target, store);
    storeOwner.notifyStoredChatOutboxChanges();
  }
  sessionStorage.setItem(seedKey, "1");
}

export function sessionDesignInitScript(
  scenario: ControlUiMockGatewayScenario,
  sandbox: SessionDesignSandbox,
): string {
  const sharing = Object.fromEntries(
    (scenario.sessions ?? []).map((session) => {
      if (typeof session.sessionId !== "string") {
        throw new Error("Session design sharing requires saved sessions");
      }
      return [
        session.key,
        {
          sessionId: session.sessionId,
          result: {
            sessionKey: session.key,
            members: [],
            identities: [],
            role: "admin",
            allowedVisibilities: scenario.allowedSessionVisibilities ?? [
              "shared",
              "read-only",
              "suggest",
              "draft",
            ],
            ...(session.key === "agent:main:completed"
              ? {
                  publicShare: {
                    token: "v1.session_design_completed_initial",
                    createdAt: Date.now(),
                  },
                  owner: { type: "human", id: riley.id, label: riley.label },
                  identities: [avery, mira, riley].map(({ type, id, label }) => ({
                    type,
                    id,
                    label,
                  })),
                  members: [{ identityId: mira.id, addedBy: riley.id, addedAt: Date.now() }],
                }
              : {}),
          } satisfies SessionMembersListEvidenceResult,
        },
      ];
    }),
  );
  // These cases are produced above; the reader projects the same immutable data and
  // adds honest errors for unknown directories instead of using the root fallback.
  const fileCases = scenario.methodResponses?.["sessions.files.list"] as {
    cases: {
      match?: { sessionKey?: string; path?: string };
      response: SessionsFilesListResult | typeof missing;
    }[];
  };
  const fileListings: Record<string, Record<string, SessionsFilesListResult>> = {};
  for (const entry of fileCases.cases) {
    if (entry.match?.sessionKey && "files" in entry.response) {
      (fileListings[entry.match.sessionKey] ??= {})[entry.match.path ?? ""] = entry.response;
    }
  }
  const snapshots = Object.fromEntries(
    (scenario.sessions ?? []).map((session) => [
      session.key,
      {
        status: "ready",
        rateLimited: false,
        pullRequests:
          session.key === MAIN
            ? [
                {
                  number: 42,
                  owner: "synthetic",
                  repo: "session-design",
                  branch: "feature/session-diff-panel",
                  title: "Polish the release session workspace",
                  url: "https://github.com/synthetic/session-design/pull/42",
                  state: "open",
                  additions: 6,
                  deletions: 2,
                  changedFiles: 3,
                  author: { login: "mira-demo" },
                  checks: { state: "passing", passed: 3, failed: 0, skipped: 0, running: 0 },
                },
              ]
            : [],
        ...(session.projectId === "session-design"
          ? { repository: { owner: "synthetic", repo: "session-design" } }
          : {}),
        ...(session.key === HANDOFF
          ? {
              branch: {
                owner: "synthetic",
                repo: "session-design",
                branch: HANDOFF_BRANCH,
                additions: 6,
                deletions: 2,
                changedFiles: 3,
              },
            }
          : {}),
      } satisfies ControlUiSessionPullRequestSnapshot,
    ]),
  );
  return `(() => { const __name = (target) => target; (${installSessionDesign.toString()})(${JSON.stringify(snapshots)}, ${JSON.stringify(fileListings)}, ${Date.now()}, ${JSON.stringify(SESSION_DESIGN_PORTAL_PATH)}, ${JSON.stringify(sharing)}, ${JSON.stringify(sandbox)}, ${CANVAS_DOCUMENT_PREVIEW_MAX_BYTES}); void (${seedSessionDesignMobileQueue.toString()})(${JSON.stringify(MOBILE_QUEUE)}); })();`;
}
