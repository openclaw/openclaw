# Computer Use Plugin

Optional OpenClaw plugin for orchestrating GPT-5.4-based computer-use tasks.

This plugin is intentionally narrow:

- OpenClaw exposes a `computer-use` tool
- the plugin forwards requests to an external executor service
- the executor owns screenshots, action execution, confirmation, and isolation
- the executor endpoint is fixed by plugin config rather than tool-call params

## Why this shape

This keeps risky desktop control outside OpenClaw core while still letting
agents, workflows, and subagents coordinate computer-use jobs.

## Tool actions

- `start`: create a new computer-use task
- `status`: inspect task state
- `confirm`: approve or reject a blocked task
- `cancel`: stop a running task

## Tiny demo

The plugin is intentionally executor-agnostic, so this PR does not ship a full
desktop runner. The smallest working flow is:

1. Configure the plugin with a fixed `executorBaseUrl`.
2. Run any HTTP service that implements the four task endpoints below.
3. Call the `computer-use` tool with `action: "start"`.
4. Poll with `status`, then use `confirm` or `cancel` when needed.

Minimal tool-call sequence:

```json
{ "action": "start", "task": "Open example.com and report the page title" }
```

Example follow-up calls after the executor returns `taskId: "task_123"`:

```json
{ "action": "status", "taskId": "task_123" }
{ "action": "confirm", "taskId": "task_123", "allow": true }
{ "action": "cancel", "taskId": "task_123" }
```

Minimal executor stub shape:

```ts
app.post("/v1/tasks", (_req, res) => {
  res.json({ taskId: "task_123", status: "blocked", needsConfirmation: true });
});

app.get("/v1/tasks/:taskId", (req, res) => {
  res.json({ taskId: req.params.taskId, status: "blocked" });
});

app.post("/v1/tasks/:taskId/confirm", (req, res) => {
  res.json({ taskId: req.params.taskId, status: req.body.allow ? "running" : "rejected" });
});

app.post("/v1/tasks/:taskId/cancel", (req, res) => {
  res.json({ taskId: req.params.taskId, status: "cancelled" });
});
```

## Example config

```json5
{
  plugins: {
    entries: {
      "computer-use": {
        enabled: true,
        config: {
          executorBaseUrl: "http://127.0.0.1:8100",
          executorAuthToken: "local-dev-token",
          defaultProvider: "openai",
          defaultModel: "gpt-5.4",
          defaultRequireConfirmation: true,
          defaultMaxSteps: 25,
          defaultTimeoutMs: 120000,
        },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: ["computer-use"],
        },
      },
    ],
  },
}
```

## Executor contract

The plugin expects the following endpoints:

- `POST /v1/tasks`
- `GET /v1/tasks/:taskId`
- `POST /v1/tasks/:taskId/confirm`
- `POST /v1/tasks/:taskId/cancel`

See [docs/design/gpt-5.4-computer-use-plugin.md](../../docs/design/gpt-5.4-computer-use-plugin.md)
for the proposed request and response shape.
