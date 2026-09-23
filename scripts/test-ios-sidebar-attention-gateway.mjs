// Synthetic loopback Gateway for SidebarAttentionUITests. No provider or command execution.
// Run: node scripts/test-ios-sidebar-attention-gateway.mjs
// Forward these settings through xcodebuild's TEST_RUNNER_ environment prefix:
// OPENCLAW_IOS_ATTENTION_FIXTURE_URL=http://127.0.0.1:19877
// OPENCLAW_IOS_LIVE_SETUP_CODE={"url":"ws://127.0.0.1:19877","token":"synthetic-attention-token"}
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const port = 19877;
const mainKey = "agent:main:main";
const parentKey = "agent:main:attention-parent";
const reviewKey = "agent:main:attention-review";
const requests = [];
let questions = [];
let approvals = [];
let created;

function reset() {
  created = Date.now();
  questions = ["Which draft should we review first?", "Should the summary include a timeline?"].map(
    (question, index) => ({
      id: `attention-question-${index + 1}`,
      questions: [
        {
          questionId: "choice",
          header: "Review",
          question,
          options: [{ label: "Draft A" }, { label: "Draft B" }],
        },
        ...(index === 0
          ? [
              {
                questionId: "reviewer",
                header: "Reviewer",
                question: "Who should review the appendix?",
                options: [{ label: "Research team" }, { label: "Editor" }],
              },
            ]
          : []),
      ],
      agentId: "main",
      sessionKey: reviewKey,
      createdAtMs: created + index,
      expiresAtMs: created + 3_600_000,
      status: "pending",
    }),
  );
  approvals = ["exec", "exec", "plugin", "plugin", "system-agent", "system-agent"].map(
    (kind, index) => {
      const presentation =
        kind === "exec"
          ? {
              kind,
              commandText: "echo synthetic-review",
              commandPreview:
                index === 0
                  ? "Inspect the synthetic review folder"
                  : "Summarize the synthetic notes",
              allowedDecisions: ["allow-once", "deny"],
              agentId: "main",
              host: "gateway",
            }
          : kind === "plugin"
            ? {
                kind,
                title: `Review synthetic plugin action ${index - 1}`,
                description: "A synthetic plugin request. No external action runs.",
                severity: "info",
                pluginId: "synthetic",
                toolName: "review",
                allowedDecisions: ["allow-once", "deny"],
                agentId: "main",
              }
            : {
                kind,
                title: `Review synthetic proposal ${index - 3}`,
                description: "A synthetic proposal. No state outside the fixture changes.",
                proposalHash: `synthetic-proposal-${index}`,
                allowedDecisions: [],
                agentId: "main",
              };
      return {
        id: `attention-approval-${index + 1}`,
        urlPath: `/approval/attention-approval-${index + 1}`,
        createdAtMs: created + 100 + index,
        expiresAtMs: created + 3_600_000,
        status: "pending",
        sourceSessionKey: reviewKey,
        presentation,
      };
    },
  );
  requests.length = 0;
}
reset();

const methods = [
  "health",
  "config.get",
  "agents.list",
  "sessions.list",
  "chat.history",
  "voicewake.get",
  "question.list",
  "question.get",
  "question.resolve",
  "exec.approval.list",
  "plugin.approval.list",
  "openclaw.approval.list",
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
  "sessions.groups.list",
];
const events = [
  "question.requested",
  "question.resolved",
  "exec.approval.requested",
  "exec.approval.resolved",
  "plugin.approval.resolved",
  "openclaw.approval.resolved",
  "tick",
];
function broadcast(event, payload) {
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN && ws.proofRole === "operator") {
      ws.send(JSON.stringify({ type: "event", event, payload }));
    }
  }
}
function settleQuestions(status, id) {
  for (const question of questions.filter(
    (entry) => entry.status === "pending" && (id === undefined || entry.id === id),
  )) {
    question.status = status;
    if (status === "answered") {
      question.answers = {
        answers: Object.fromEntries(
          question.questions.map((item) => [item.questionId, [item.options[0].label]]),
        ),
      };
    }
    broadcast("question.resolved", {
      id: question.id,
      status,
      ...(question.answers ? { answers: question.answers } : {}),
    });
  }
}
function addParentQuestion() {
  const question = {
    id: "attention-question-parent",
    questions: [
      {
        questionId: "page",
        header: "Website",
        question: "Which page should we refresh first?",
        options: [{ label: "Home page" }, { label: "About page" }],
      },
    ],
    agentId: "main",
    sessionKey: parentKey,
    createdAtMs: created - 100,
    expiresAtMs: created + 3_600_000,
    status: "pending",
  };
  questions.push(question);
  broadcast("question.requested", question);
}
function settleApprovals(status, id) {
  for (const approval of approvals.filter(
    (entry) => entry.status === "pending" && (id === undefined || entry.id === id),
  )) {
    approval.status = status;
    approval.resolvedAtMs = Date.now();
    approval.reason = status === "expired" ? "timeout" : "run-aborted";
    const family =
      approval.presentation.kind === "system-agent" ? "openclaw" : approval.presentation.kind;
    broadcast(`${family}.approval.resolved`, {
      id: approval.id,
      decision: "deny",
      resolvedAtMs: approval.resolvedAtMs,
    });
  }
}
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  const path = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
  if (req.method === "POST") {
    if (path === "/reset") {
      reset();
    } else if (path === "/questions/answer") {
      settleQuestions("answered");
    } else if (path === "/questions/answer-oldest") {
      settleQuestions("answered", questions[0].id);
    } else if (path === "/questions/add-parent") {
      addParentQuestion();
    } else if (path === "/questions/cancel-parent") {
      settleQuestions("cancelled", "attention-question-parent");
    } else if (path === "/questions/expire-newer") {
      settleQuestions("expired", questions[1].id);
    } else if (path === "/questions/cancel") {
      settleQuestions("cancelled");
    } else if (path === "/questions/expire") {
      settleQuestions("expired");
    } else if (path === "/approvals/cancel") {
      settleApprovals("cancelled");
    } else if (path === "/approvals/expire") {
      settleApprovals("expired");
    } else if (path === "/approvals/expire-last") {
      settleApprovals("expired", approvals.at(-1).id);
    } else {
      res.writeHead(404);
      res.end("{}");
      return;
    }
  }
  res.end(
    JSON.stringify({
      requests,
      questions: questions.map(({ id, status }) => ({ id, status })),
      approvals: approvals.map(({ id, status }) => ({ id, status })),
      connections: wss.clients.size,
    }),
  );
});
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "synthetic-attention-nonce", ts: Date.now() },
    }),
  );
  ws.on("message", (raw) => {
    const req = JSON.parse(Buffer.from(raw).toString("utf8"));
    if (req.type !== "req") {
      return;
    }
    const params = req.params ?? {};
    requests.push({ method: req.method, sessionKey: params.sessionKey, id: params.id });
    console.log(JSON.stringify(requests.at(-1)));
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
    if (req.method.endsWith(".approval.list")) {
      const kind = req.method.startsWith("openclaw") ? "system-agent" : req.method.split(".")[0];
      reply(
        approvals
          .filter((entry) => entry.status === "pending" && entry.presentation.kind === kind)
          .map((entry) => ({
            id: entry.id,
            approvalKind: kind,
            createdAtMs: entry.createdAtMs,
            expiresAtMs: entry.expiresAtMs,
            request: { sessionKey: entry.sourceSessionKey, agentId: "main" },
          })),
      );
      return;
    }
    switch (req.method) {
      case "connect":
        ws.proofRole = params.role;
        reply({
          type: "hello-ok",
          protocol: 3,
          server: { version: "synthetic-attention", connId: "synthetic" },
          features: { methods, events },
          snapshot: {
            presence: [],
            health: { ok: true },
            stateVersion: { presence: 1, health: 1 },
            uptimeMs: 1000,
            sessionDefaults: {
              defaultAgentId: "main",
              mainKey: "main",
              mainSessionKey: mainKey,
              scope: "per-sender",
            },
          },
          auth: {
            role: params.role,
            scopes: params.scopes ?? [],
            deviceToken: `synthetic-${params.role}`,
          },
          policy: { maxPayload: 1048576, maxBufferedBytes: 1048576, tickIntervalMs: 30000 },
        });
        break;
      case "health":
        reply({
          ok: true,
          ts: Date.now(),
          durationMs: 1,
          channels: {},
          agents: [],
          sessions: { count: 3 },
        });
        break;
      case "config.get":
        reply({
          config: { agents: { defaults: {} }, gateway: { mode: "local" } },
          hash: "synthetic",
          valid: true,
        });
        break;
      case "agents.list":
        reply({
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main", name: "Research assistant" }],
        });
        break;
      case "sessions.list":
        reply({
          ts: Date.now(),
          count: 3,
          totalCount: 3,
          offset: 0,
          nextOffset: 3,
          hasMore: false,
          defaults: {},
          sessions: [
            {
              key: mainKey,
              displayName: "Home",
              label: "Home",
              kind: "direct",
              updatedAt: created,
              totalTokens: 120,
            },
            {
              key: parentKey,
              displayName: "Website refresh",
              label: "Website refresh",
              category: "Research",
              kind: "direct",
              childSessions: [reviewKey],
              updatedAt: created - 30000,
              totalTokens: 60,
            },
            {
              key: reviewKey,
              displayName: "Pending review",
              label: "Pending review",
              category: "Research",
              kind: "direct",
              updatedAt: created - 60000,
              totalTokens: 84,
            },
          ],
        });
        break;
      case "chat.history":
        reply({
          sessionKey: params.sessionKey ?? mainKey,
          sessionId: "synthetic-session",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Your research workspace is ready." }],
              timestamp: created,
            },
          ],
        });
        break;
      case "question.list":
        reply({ questions: questions.filter((entry) => entry.status === "pending") });
        break;
      case "question.get":
        reply({ question: questions.find((entry) => entry.id === params.id) });
        break;
      case "question.resolve": {
        const question = questions.find((entry) => entry.id === params.id);
        if (!question) {
          fail("Unknown synthetic question");
          break;
        }
        question.status = params.cancel === true ? "cancelled" : "answered";
        if (question.status === "answered") {
          question.answers = params.answers;
        }
        const result = {
          id: question.id,
          status: question.status,
          ...(question.answers ? { answers: question.answers } : {}),
        };
        reply(result);
        broadcast("question.resolved", result);
        break;
      }
      case "approval.get":
        reply({ approval: approvals.find((entry) => entry.id === params.id) });
        break;
      case "approval.resolve":
        fail("Use the fixture lifecycle endpoints; no approval actions execute");
        break;
      case "voicewake.get":
        reply({ triggers: [] });
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
      case "models.list":
        reply({ models: [] });
        break;
      case "sessions.groups.list":
        reply({ groups: [{ name: "Research", position: 0 }] });
        break;
      case "sessions.preview":
        reply({ ts: Date.now(), previews: [] });
        break;
      default:
        fail(`Unsupported synthetic method: ${req.method}`);
    }
  });
});
const tick = setInterval(() => broadcast("tick", { ts: Date.now() }), 10_000);
server.listen(port, "127.0.0.1", () =>
  console.log(`Synthetic attention Gateway listening on loopback:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(tick);
    for (const ws of wss.clients) {
      ws.terminate();
    }
    wss.close();
    server.close();
  });
}
