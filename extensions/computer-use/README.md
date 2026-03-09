# Computer Use Plugin

Optional OpenClaw plugin for orchestrating GPT-5.4-based computer-use tasks.

This plugin is intentionally narrow:

- OpenClaw exposes a `computer-use` tool
- the plugin forwards requests to an external executor service
- the executor owns screenshots, action execution, confirmation, and isolation

## Why this shape

This keeps risky desktop control outside OpenClaw core while still letting
agents, workflows, and subagents coordinate computer-use jobs.

## Tool actions

- `start`: create a new computer-use task
- `status`: inspect task state
- `confirm`: approve or reject a blocked task
- `cancel`: stop a running task

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
          defaultTimeoutMs: 120000
        }
      }
    }
  },
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: ["computer-use"]
        }
      }
    ]
  }
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
