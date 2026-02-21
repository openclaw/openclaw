# AI Assistant Security Plugin

`@omni-shield/ai-assistant-security-openclaw` is a security plugin designed for OpenClaw to protect your Large Language Models (LLM) and Agent lifecycle from harmful requests and sensitive data leakage.

## Key Features

- **Multi-dimensional Protection**: Covers LLM requests, pre-tool calls (Before Tool Call), and tool result persistence (Tool Result Persist).
- **Global Interception**: Hooks into `global.fetch` to provide automated security auditing for underlying model calls.
- **Smart Degradation (Circuit Breaker)**: Built-in error handling and self-healing logic. Automatically enters degradation mode when security API failures exceed the threshold, ensuring business continuity.
- **Session Synchronization**: Automatically synchronizes OpenClaw session files to mark intercepted content when a request is blocked.
- **Risk Label Support**: Supports returning specific risk labels (e.g., PII, Prompt Injection) and displaying them in block messages.

## Quick Start

Bundled plugins are disabled by default in OpenClaw. You can enable it using the following command:

```bash
openclaw plugins enable ai-assistant-security-openclaw
```

Restart the Gateway after enabling.

## Configuration

Configure the plugin in your OpenClaw configuration file:

```yaml
plugins:
  ai-assistant-security-openclaw:
    enabled: true
    config:
      endpoint: "https://your-security-api-endpoint"  # Security API endpoint (Required)
      apiKey: "your-api-key-here"                     # API Key (Required)
      appId: "your-app-id"                            # Application Identifier (Required)
      timeoutMs: 5000                                 # API timeout in ms, default is no limit
      logRecord: true                                 # Enable plugin runtime logs, default is false
      failureThreshold: 3                             # Failures before entering degradation, default is 3
      retryInterval: 60                               # Initial retry interval in seconds after degradation, default is 60
      maxRetryInterval: 3600                          # Max retry interval in seconds, default is 
      enableFetch: true                                   # Whether to hook global.fetch
      enableBeforeToolCall: true                          # Whether to audit before tool execution
      enableToolResultPersist: false                       # Whether to audit before persisting tool results
```

## Workflow

1. **Registration & Validation**: Validates the availability of `endpoint`, `apiKey`, and `appId` during startup.
2. **Security Audit**:
   - **LLM Requests**: Monitors inputs sent to models.
   - **Pre-Tool Call**: Audits the tool name and its parameters before execution.
   - **Tool Result**: Audits raw data returned by tools to prevent sensitive information leakage.
3. **Interception**: If a risk is detected, the plugin returns a block message or rewrites the response content accordingly.
4. **Disaster Recovery**: If the security service is unavailable, the plugin automatically bypasses checks to prioritize business availability and periodically probes for service recovery.
