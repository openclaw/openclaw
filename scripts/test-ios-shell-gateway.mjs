// Synthetic loopback Gateway for native iOS navigation and model-policy UI tests.
// This fixture never executes commands or resolves approvals.
// First terminal, from the repository root: node scripts/test-ios-shell-gateway.mjs
// Second terminal: pnpm ios:gen, then run the two cases on a fresh owned simulator:
// TEST_RUNNER_OPENCLAW_IOS_LIVE_GATEWAY=1 \
// TEST_RUNNER_OPENCLAW_IOS_LIVE_SETUP_CODE='{"url":"ws://127.0.0.1:19876","token":"synthetic-navigation-token"}' \
// TEST_RUNNER_OPENCLAW_IOS_APPROVAL_FIXTURE_URL=http://127.0.0.1:19876 \
// xcodebuild test -project apps/ios/OpenClaw.xcodeproj -scheme OpenClawUITests \
//   -destination 'platform=iOS Simulator,id=<owned-simulator-udid>' \
//   -derivedDataPath /tmp/openclaw-ios-navigation-proof -jobs 4 -parallel-testing-enabled NO \
//   -only-testing:OpenClawUITests/OpenClawSnapshotUITests/testLiveGatewayApprovalNotificationsFromOverview \
//   -only-testing:OpenClawUITests/OpenClawSnapshotUITests/testLiveGatewayApprovalNotificationsFromSettings
// TEST_RUNNER_ forwards these opt-in settings to XCTest; no real Gateway credentials are used.
// For the Guest catalog case, start this fixture with --guest-model-policy and select
// OpenClawUITests/ChatCatalogUITests/testGuestModelPolicyRetiresOpenChoices.
// Forward OPENCLAW_IOS_GUEST_MODEL_POLICY_PROOF=1, OPENCLAW_IOS_LIVE_SETUP_CODE,
// and OPENCLAW_IOS_MODEL_POLICY_FIXTURE_URL=http://127.0.0.1:19876 via TEST_RUNNER_.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
const attachmentMode = process.argv.includes("--attachments");
const attachmentMessage = attachmentMode
  ? JSON.parse(
      readFileSync(
        new URL("../apps/ios/Tests/Fixtures/managed-document-message.json", import.meta.url),
        "utf8",
      ),
    )
  : null;
const documentBytes = Buffer.from("name,value\nproof,1\n");
const document = attachmentMessage?.content.at(-1).attachment;
let documentDenied = false;
let documentDownloads = 0;
const requests = [];
const guestModelPolicy = process.argv.includes("--guest-model-policy");
const guestScopes = ["operator.sessions.write"];
const policySessionKey = "agent:main:main";
const policyHistoryText = "Saved response from fixture/excluded. Keep this history.";
const policyReads = [];
const policyPatches = [];
const policyEvents = [];
const heldPolicyReads = new Set();
const policyWaiters = new Set();
const attachmentReadyWaiters = new Set();
let policyPhase = "permitted";
let policyHistoryReads = 0;
let partial = false;
const created = Date.now();
const approval = {
  id: "navigation-proof-approval",
  urlPath: "/approval/navigation-proof-approval",
  createdAtMs: created,
  expiresAtMs: created + 3_600_000,
  status: "pending",
  presentation: {
    kind: "exec",
    commandText: "echo navigation-proof",
    commandPreview: "Synthetic navigation check — no command executes",
    allowedDecisions: ["allow-once", "deny"],
    agentId: "main",
    host: "gateway",
  },
};
const sessions = Array.from({ length: attachmentMode ? 1 : 205 }, (_, i) => ({
  key: i === 0 ? "agent:main:main" : `agent:main:navigation-${i}`,
  displayName: i === 0 ? "Navigation proof" : `Synthetic session ${i}`,
  label: i === 0 ? "Navigation proof" : `Synthetic session ${i}`,
  kind: "direct",
  updatedAt: created - i * 1000,
  totalTokens: 100 + i,
  inputTokens: 80 + i,
  outputTokens: 20,
}));
const methods = [
  "health",
  "config.get",
  "agents.list",
  "sessions.list",
  "chat.history",
  "voicewake.get",
  "approval.get",
  "approval.resolve",
  "cron.list",
  "cron.status",
  "system-presence",
  "node.list",
  "sessions.subscribe",
  "sessions.unsubscribe",
  "session.status",
  "models.list",
  "sessions.preview",
  "chat.send",
  ...(attachmentMode ? ["artifacts.download"] : []),
];

function policyCatalog() {
  const modelIDs =
    policyPhase === "permitted"
      ? ["primary", "custom"]
      : policyPhase === "null"
        ? ["custom"]
        : ["primary", "fallback"];
  return {
    models: modelIDs.map((id) => ({
      id,
      name: id,
      provider: "fixture",
      available: true,
      supportsFastMode: false,
      thinkingLevels: [{ id: "off", label: "Off" }],
    })),
    modelSelectionPolicy: {
      restricted: true,
      defaultModel: policyPhase === "null" ? null : "fixture/primary",
    },
  };
}

function policyState() {
  return {
    phase: policyPhase,
    operatorGrants: [...wss.clients]
      .filter((ws) => ws.readyState === WebSocket.OPEN && ws.proofRole === "operator")
      .map((ws) => ws.proofScopes),
    reads: policyReads,
    heldReads: heldPolicyReads.size,
    patches: policyPatches,
    patchCount: policyPatches.length,
    events: policyEvents,
    savedModel: "fixture/excluded",
    historyText: policyHistoryText,
    historyReads: policyHistoryReads,
  };
}

function sendPolicyState(res) {
  res.end(JSON.stringify(policyState()));
}

function notifyPolicyWaiters() {
  if (!policyReads.some((read) => read.phase === policyPhase)) {
    return;
  }
  for (const res of policyWaiters) {
    sendPolicyState(res);
  }
  policyWaiters.clear();
}

function notifyAttachmentReadyWaiters() {
  if (!requests.some((request) => request.method === "node.pending.pull")) {
    return;
  }
  for (const res of attachmentReadyWaiters) {
    res.end(JSON.stringify({ ready: true }));
  }
  attachmentReadyWaiters.clear();
}

function publishPolicyChange() {
  let delivered = 0;
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN && ws.proofRole === "operator") {
      ws.send(
        JSON.stringify({
          type: "event",
          event: "chat.metadata.changed",
          payload: { modelSelectionChanged: true },
        }),
      );
      delivered++;
    }
  }
  policyEvents.push({ phase: policyPhase, delivered, atMs: Date.now() });
}

function handlePolicyControl(req, res) {
  if (!guestModelPolicy || !req.url?.startsWith("/model-policy")) {
    return false;
  }
  if (req.method === "GET" && req.url === "/model-policy") {
    sendPolicyState(res);
  } else if (req.method === "GET" && req.url === "/model-policy/await-catalog") {
    policyWaiters.add(res);
    res.once("close", () => policyWaiters.delete(res));
    notifyPolicyWaiters();
  } else if (req.method === "POST") {
    const transitions = { null: "permitted", hold: "null", fail: "held", recover: "failed" };
    const action = req.url.slice("/model-policy/".length);
    if (transitions[action] !== policyPhase || (action === "fail" && heldPolicyReads.size === 0)) {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: "Unexpected policy transition", phase: policyPhase }));
      return true;
    }
    policyPhase = { null: "null", hold: "held", fail: "failed", recover: "recovered" }[action];
    if (action === "fail") {
      for (const pending of heldPolicyReads) {
        pending.read.outcome = "failed";
        pending.fail("Synthetic model catalog refresh failed");
      }
      heldPolicyReads.clear();
    } else {
      publishPolicyChange();
    }
    sendPolicyState(res);
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "Unknown policy control" }));
  }
  return true;
}

const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (handlePolicyControl(req, res)) {
    return;
  }
  const url = new URL(req.url, "http://127.0.0.1");
  if (attachmentMode && url.pathname === "/attachment-ready") {
    attachmentReadyWaiters.add(res);
    res.once("close", () => attachmentReadyWaiters.delete(res));
    notifyAttachmentReadyWaiters();
    return;
  } else if (attachmentMode && url.pathname === document.url) {
    if (documentDenied || url.searchParams.get("mediaTicket") !== "synthetic-document-ticket") {
      res.writeHead(410);
      res.end(JSON.stringify({ error: "Synthetic document expired" }));
      return;
    }
    documentDownloads++;
    res.writeHead(200, {
      "content-type": "text/csv",
      "content-length": documentBytes.length,
      "content-disposition": 'attachment; filename="report.csv"',
    });
    res.end(documentBytes);
    return;
  }
  if (attachmentMode && url.pathname === "/attachment-denied") {
    documentDenied = true;
    res.end(JSON.stringify({ documentDenied }));
  } else if (req.url === "/approval") {
    let count = 0;
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN && ws.proofRole === "operator") {
        ws.send(
          JSON.stringify({
            type: "event",
            event: "exec.approval.requested",
            payload: { id: approval.id },
          }),
        );
        count++;
      }
    }
    res.end(JSON.stringify({ sent: count }));
  } else if (req.url === "/partial") {
    partial = true;
    res.end(JSON.stringify({ partial }));
  } else if (req.url === "/complete") {
    partial = false;
    res.end(JSON.stringify({ partial }));
  } else {
    res.end(
      JSON.stringify({ requests, connections: wss.clients.size, partial, documentDownloads }),
    );
  }
});
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "synthetic-proof-nonce", ts: Date.now() },
    }),
  );
  ws.on("message", (raw) => {
    const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
    const req = JSON.parse(data.toString("utf8"));
    if (req.type !== "req") {
      return;
    }
    const params = req.params ?? {};
    requests.push({
      method: req.method,
      offset: params.offset,
      limit: params.limit,
      role: params.role,
      sessionKey: params.sessionKey,
      artifactId: params.artifactId,
      ...(guestModelPolicy ? { key: params.key } : {}),
    });
    notifyAttachmentReadyWaiters();
    const reply = (payload) =>
      ws.send(JSON.stringify({ type: "res", id: req.id, ok: true, payload }));
    const fail = (message) =>
      ws.send(
        JSON.stringify({
          type: "res",
          id: req.id,
          ok: false,
          error: { code: "INVALID_REQUEST", message },
        }),
      );
    console.log(JSON.stringify(requests.at(-1)));
    if (guestModelPolicy && req.method === "config.get") {
      fail("Missing scope: operator.read");
      return;
    }
    if (
      guestModelPolicy &&
      ["models.list", "sessions.list", "chat.history"].includes(req.method) &&
      !ws.proofScopes?.includes("operator.sessions.read") &&
      !ws.proofScopes?.includes("operator.sessions.write")
    ) {
      fail("Missing scope: operator.sessions.read");
      return;
    }
    switch (req.method) {
      case "connect": {
        ws.proofRole = params.role;
        ws.proofScopes = guestModelPolicy
          ? params.role === "operator"
            ? guestScopes
            : []
          : (params.scopes ?? []);
        reply({
          type: "hello-ok",
          protocol: 3,
          server: { version: "navigation-proof", connId: "synthetic" },
          features: guestModelPolicy
            ? {
                methods: [...methods, "sessions.patch"],
                events: ["chat.metadata.changed", "tick"],
                capabilities: ["published-model-catalog"],
              }
            : { methods, events: ["exec.approval.requested", "tick"] },
          snapshot: {
            presence: [],
            health: { ok: true },
            stateVersion: { presence: 1, health: 1 },
            uptimeMs: 1000,
            sessionDefaults: {
              defaultAgentId: "main",
              mainKey: "main",
              mainSessionKey: "agent:main:main",
              scope: "per-sender",
            },
          },
          auth: {
            role: params.role,
            scopes: ws.proofScopes,
            deviceToken: `synthetic-${params.role}`,
          },
          policy: { maxPayload: 1048576, maxBufferedBytes: 1048576, tickIntervalMs: 30000 },
        });
        break;
      }
      case "health":
        reply({
          ok: true,
          ts: Date.now(),
          durationMs: 1,
          channels: {},
          agents: [],
          sessions: { count: 205 },
        });
        break;
      case "config.get":
        reply({
          config: {
            agents: { defaults: { model: { primary: "openai/gpt-5" } } },
            gateway: { mode: "local" },
          },
          hash: "synthetic",
          valid: true,
        });
        break;
      case "agents.list":
        reply({
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main", name: "Navigation proof" }],
        });
        break;
      case "sessions.list": {
        if (guestModelPolicy) {
          reply({
            ts: Date.now(),
            count: 1,
            totalCount: 1,
            hasMore: false,
            defaults: {
              modelProvider: "fixture",
              model: "legacy-default",
              modelSelectionTarget: "session",
            },
            sessions: [
              {
                key: policySessionKey,
                sessionId: "synthetic-policy-session",
                kind: "direct",
                displayName: "Guest policy proof",
                modelProvider: "fixture",
                model: "excluded",
                updatedAt: created,
                totalTokens: 100,
              },
            ],
          });
          break;
        }
        const offset = params.offset ?? 0;
        if (partial && offset > 0) {
          fail("Synthetic later-page failure");
          break;
        }
        const rows = sessions.slice(offset, offset + (params.limit ?? 200));
        reply({
          ts: Date.now(),
          count: rows.length,
          totalCount: sessions.length,
          offset,
          nextOffset: offset + rows.length,
          hasMore: offset + rows.length < sessions.length,
          defaults: {},
          sessions: rows,
        });
        break;
      }
      case "chat.history":
        if (guestModelPolicy) {
          policyHistoryReads++;
        }
        reply({
          sessionKey: params.sessionKey ?? "agent:main:main",
          sessionId: guestModelPolicy ? "synthetic-policy-session" : "synthetic-session",
          messages: guestModelPolicy
            ? [
                {
                  role: "assistant",
                  content: [{ type: "text", text: policyHistoryText }],
                  timestamp: created,
                  model: "excluded",
                  provider: "fixture",
                },
              ]
            : attachmentMode
              ? [attachmentMessage]
              : [],
        });
        break;
      case "artifacts.download":
        if (
          !attachmentMode ||
          params.artifactId !== document.artifactId ||
          !["main", "agent:main:main"].includes(params.sessionKey)
        ) {
          fail("Unexpected artifact scope");
          break;
        }
        reply({
          artifact: {
            id: document.artifactId,
            type: "file",
            title: document.label,
            mimeType: document.mimeType,
            sizeBytes: documentBytes.length,
            download: { mode: "url" },
          },
          url: document.url + "?mediaTicket=synthetic-document-ticket",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        });
        break;
      case "voicewake.get":
        reply({ triggers: [] });
        break;
      case "approval.get":
        reply({ approval });
        break;
      case "approval.resolve":
        fail("Navigation proof never executes or approves commands");
        break;
      case "cron.list":
        reply({ jobs: [] });
        break;
      case "cron.status":
        reply({ enabled: true, jobs: 0 });
        break;
      case "system-presence":
        reply([]);
        break;
      case "node.list":
        reply({ nodes: [] });
        break;
      case "sessions.subscribe":
      case "sessions.unsubscribe":
        reply({ ok: true });
        break;
      case "models.list": {
        if (!guestModelPolicy) {
          reply({ models: [] });
          break;
        }
        const read = {
          phase: policyPhase,
          outcome: policyPhase === "held" ? "held" : "returned",
          atMs: Date.now(),
        };
        policyReads.push(read);
        if (policyPhase === "held") {
          const pending = { ws, read, fail };
          heldPolicyReads.add(pending);
          ws.once("close", () => heldPolicyReads.delete(pending));
        } else if (policyPhase === "failed") {
          read.outcome = "failed";
          fail("Synthetic model catalog refresh failed");
        } else {
          reply(policyCatalog());
        }
        notifyPolicyWaiters();
        break;
      }
      case "sessions.patch":
        if (!guestModelPolicy) {
          fail(`Unsupported synthetic method: ${req.method}`);
          break;
        }
        policyPatches.push({ key: params.key, model: params.model });
        // Model settings require general write even though the Guest can edit
        // session labels. Keep this admission boundary visible to the app.
        fail("Missing scope: operator.write");
        break;
      case "sessions.preview":
        reply({ ts: Date.now(), previews: [] });
        break;
      default:
        fail(`Unsupported synthetic method: ${req.method}`);
    }
  });
});
const tick = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "event", event: "tick", payload: { ts: Date.now() } }));
    }
  }
}, 10_000);
server.listen(19876, "127.0.0.1", () =>
  console.log("Synthetic Gateway listening on loopback:19876"),
);
function stop() {
  clearInterval(tick);
  for (const res of policyWaiters) {
    res.destroy();
  }
  policyWaiters.clear();
  for (const res of attachmentReadyWaiters) {
    res.destroy();
  }
  attachmentReadyWaiters.clear();
  // close() waits for existing peers; a connected simulator must not keep this fixture alive.
  for (const ws of wss.clients) {
    ws.terminate();
  }
  wss.close();
  server.close();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
