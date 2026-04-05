# PromptGuard Security Plugin

This OpenClaw plugin automatically scans messages and tool calls for security threats using the PromptGuard API. It uses a hooks-based architecture and does not expose standalone MCP tools.

## What the plugin does

The following hooks run automatically when the plugin is enabled and configured:

- **before_agent_reply**: scans user messages for prompt injection before sending to the LLM. In enforce mode, malicious messages are blocked with a user-visible explanation.
- **before_tool_call**: validates tool arguments against known attack patterns (data exfiltration, code injection, privilege escalation). In enforce mode, flagged calls are blocked.
- **message_sending**: optionally redacts PII (names, emails, phone numbers, SSNs, credit cards) from outgoing messages when `redactPii` is enabled.
- **llm_input / llm_output**: telemetry hooks that forward prompts and completions to PromptGuard for threat analytics (only when `scanInputs` is enabled).

## Configuration

Users configure the plugin via `openclaw config set plugins.entries.promptguard.config.security.*` or through the setup wizard. Key settings:

| Key            | Default    | Description                                   |
| -------------- | ---------- | --------------------------------------------- |
| `apiKey`       | (required) | PromptGuard API key (`pg_...`)                |
| `mode`         | `monitor`  | `enforce` blocks threats, `monitor` logs only |
| `scanInputs`   | `true`     | Scan user messages for prompt injection       |
| `scanToolArgs` | `true`     | Scan tool arguments before execution          |
| `redactPii`    | `false`    | Redact PII from outgoing messages             |
| `detectors`    | all        | Which threat detectors to enable              |

## Chat command

`/promptguard status` -- shows connection and config status.
`/promptguard test [text]` -- runs a test scan on the given text.
