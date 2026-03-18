---
summary: "Integrate OpenClaw with AgentField — the open-source control plane for production AI backends"
read_when:
  - Connecting OpenClaw to an AgentField control plane
  - Routing chat messages to AgentField agent endpoints
  - Having AgentField agents deliver results back to OpenClaw channels
  - Building multi-agent workflows across OpenClaw and AgentField
title: "AgentField"
---

# AgentField

[AgentField](https://github.com/Agent-Field/agentfield) is an open-source control plane that treats AI agents as first-class backend services — providing routing, async execution, durable state, observability, and cryptographic identity (W3C DIDs) for production agent workloads.

OpenClaw and AgentField complement each other: OpenClaw handles the channel layer (WhatsApp, Telegram, Discord, iMessage, and more) and the reasoning loop, while AgentField hosts the backend agent services, coordinates multi-agent workflows, and provides audit trails.

Two integration directions are supported:

- **OpenClaw → AgentField**: forward chat messages or events to an AgentField agent endpoint using the webhook hook or automation rules
- **AgentField → OpenClaw**: call the OpenClaw Gateway REST API from an AgentField skill or reasoner to deliver results to any connected channel

## Prerequisites

- OpenClaw Gateway running and reachable (see [Gateway runbook](/gateway))
- AgentField control plane running (`af server`, default port `8080`)
- At least one AgentField agent node registered with the control plane

## OpenClaw → AgentField

Use OpenClaw's [webhook automation](/automation/webhook) to forward inbound messages to an AgentField agent endpoint.

### Enable webhooks

Add to your gateway config:

```json5
{
  hooks: {
    enabled: true,
    token: "your-hook-token",
    path: "/hooks",
  },
}
```

### Forward a message to AgentField from a hook skill

Create a hook skill that calls the AgentField REST API when OpenClaw receives a relevant message:

```typescript
import { Agent } from "@agentfield/sdk";

const af = new Agent({
  nodeId: "openclaw-bridge",
  agentFieldUrl: process.env.AGENTFIELD_URL ?? "http://localhost:8080",
});

af.skill("forward_message", async (_ctx, input: { url: string }) => {
  // Calls another AgentField agent through the control plane
  const result = await af.call("researcher.summarize", { input: { url: input.url } });
  return result;
});

af.run();
```

### Trigger from an OpenClaw automation hook

Use `POST /hooks/agent` to hand off work to AgentField and return the result to the requester:

```bash
curl -X POST http://your-gateway:18789/hooks/agent \
  -H "Authorization: Bearer your-hook-token" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Summarize https://example.com",
    "agentId": "hooks",
    "deliver": true,
    "channel": "last"
  }'
```

The OpenClaw agent receives the hook message, can call an AgentField endpoint directly as a tool, and delivers the result back to the originating channel.

### Direct REST call from an OpenClaw skill

An OpenClaw skill can call any AgentField agent endpoint over HTTP — no SDK required:

```typescript
// In a skill: call AgentField and return the result
const response = await fetch("http://localhost:8080/api/v1/execute/researcher.summarize", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ input: { url: "https://example.com" } }),
});
const result = await response.json();
return result.output;
```

## AgentField → OpenClaw

AgentField agents can push results back to OpenClaw channels by calling the Gateway REST API from any skill or reasoner.

### Send a message to a channel

Use `POST /hooks/agent` (or `POST /hooks/wake`) from your AgentField skill:

**TypeScript (AgentField SDK)**

```typescript
import { Agent } from "@agentfield/sdk";

const app = new Agent({
  nodeId: "notifier",
  agentFieldUrl: process.env.AGENTFIELD_URL ?? "http://localhost:8080",
});

app.skill("notify_channel", async (_ctx, input: { summary: string; to: string }) => {
  await fetch("http://your-gateway:18789/hooks/agent", {
    method: "POST",
    headers: {
      Authorization: "Bearer your-hook-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: input.summary,
      agentId: "hooks",
      deliver: true,
      channel: "telegram",
      to: input.to,
    }),
  });
  return { delivered: true };
});

app.run();
```

**Python (AgentField SDK)**

```python
import httpx
from agentfield import Agent

app = Agent(node_id="notifier")

@app.skill()
def notify_channel(summary: str, to: str) -> dict:
    httpx.post(
        "http://your-gateway:18789/hooks/agent",
        headers={
            "Authorization": "Bearer your-hook-token",
            "Content-Type": "application/json",
        },
        json={
            "message": summary,
            "agentId": "hooks",
            "deliver": True,
            "channel": "telegram",
            "to": to,
        },
    )
    return {"delivered": True}

app.run()
```

### Fan-out to multiple channels

An AgentField reasoner can classify output and route to different OpenClaw channels:

```typescript
app.reasoner("route_result", async (ctx, input: { report: string; urgency: string }) => {
  const gateway = "http://your-gateway:18789/hooks/agent";
  const token = process.env.OPENCLAW_HOOK_TOKEN;

  const channels =
    input.urgency === "high"
      ? [
          { channel: "telegram", to: "@ops-alerts" },
          { channel: "slack", to: "#incidents" },
        ]
      : [{ channel: "discord", to: "#reports" }];

  await Promise.all(
    channels.map((ch) =>
      fetch(gateway, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: input.report, agentId: "hooks", deliver: true, ...ch }),
      }),
    ),
  );

  return { routed: channels.length };
});
```

## Async long-running workflows

For tasks that run minutes or hours, use AgentField's async execution with a webhook callback pointed at the OpenClaw hook endpoint:

```python
result = await app.call(
    "research_agent.deep_dive",
    input={"topic": "quantum computing"},
    async_config=AsyncConfig(
        webhook_url="http://your-gateway:18789/hooks/agent",
        timeout_hours=6,
    ),
)
```

When the task completes, AgentField POSTs the result to `/hooks/agent`. Configure the hook agent to extract the relevant fields and deliver the final summary to the appropriate channel.

## Configuration reference

| Setting               | Where          | Notes                                              |
| --------------------- | -------------- | -------------------------------------------------- |
| `hooks.enabled`       | gateway config | Must be `true` to accept inbound hook calls        |
| `hooks.token`         | gateway config | Shared secret for `Authorization: Bearer`          |
| `hooks.path`          | gateway config | Default `/hooks`                                   |
| `AGENTFIELD_URL`      | AgentField env | Control plane URL, default `http://localhost:8080` |
| `OPENCLAW_HOOK_TOKEN` | AgentField env | Store the hook token in the agent environment      |

## Authentication

- Set `hooks.token` to a strong random secret in your gateway config.
- In AgentField agents, store the token as an environment variable (`OPENCLAW_HOOK_TOKEN`); never hard-code it.
- For mTLS or firewall-restricted deployments, ensure the AgentField control plane and OpenClaw Gateway can reach each other's endpoints.

## See also

- [Webhooks](/automation/webhook) — full hook endpoint reference
- [ACP Agents](/tools/acp-agents) — ACP runtime sessions for coding harnesses
- [Sub-agents](/tools/subagents) — OpenClaw-native delegated runs
- [Hooks](/automation/hooks) — automation hook patterns
- [Gateway configuration](/gateway/configuration) — gateway config reference
