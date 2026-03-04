---
summary: "Cloud SMS channel via Kudosity — send and receive SMS messages"
read_when:
  - Working on Kudosity SMS channel features
title: "Kudosity SMS"
---

# Kudosity SMS

Status: outbound SMS ready; inbound webhook utilities included (gateway route wiring planned as follow-up).

## Overview

The Kudosity SMS channel lets your OpenClaw agent send and receive SMS messages through [Kudosity](https://kudosity.com), an Australian cloud communications platform. SMS works on any phone — no app needed.

## Quick setup

<Steps>
  <Step title="Create a Kudosity account">
    Sign up at [kudosity.com/signup](https://kudosity.com/signup). A free trial is available.
  </Step>

  <Step title="Get your API key">
    Go to **Settings → API Keys → Create Key** in the Kudosity dashboard.
  </Step>

  <Step title="Get a sender number">
    Go to **Numbers → Lease a virtual number**, or use an existing number on your account. The number must be in E.164 format (e.g. `+61400000000`).
  </Step>

  <Step title="Run the onboarding wizard">
    The OpenClaw CLI will guide you through configuration:

    ```
    openclaw setup
    ```

    Select **SMS Kudosity** from the channel list and follow the prompts.

  </Step>
</Steps>

## Manual configuration

Add to your OpenClaw config file:

```yaml
channels:
  kudosity-sms:
    apiKey: "your-kudosity-api-key"
    sender: "+61400000000"
```

Or use environment variables:

- `KUDOSITY_API_KEY`
- `KUDOSITY_SENDER`

## Capabilities

| Feature       | Supported                                      |
| ------------- | ---------------------------------------------- |
| Text messages | ✅                                             |
| Media/MMS     | ❌ (graceful degradation — sends caption text) |
| Threads       | ❌                                             |
| Groups        | ❌                                             |
| Reactions     | ❌                                             |

## Resources

- [Kudosity Developer Docs](https://developers.kudosity.com)
- [Kudosity API Reference](https://developers.kudosity.com/reference)
- [Kudosity MCP Server](https://developers.kudosity.com/mcp)
- [Kudosity Dashboard](https://kudosity.com)

## Security

Kudosity webhooks do not currently support payload signing or shared secrets. For inbound SMS security, consider IP allowlisting at the network/reverse-proxy level. See the [Kudosity webhook documentation](https://developers.kudosity.com/reference/about-webhooks) for details.
