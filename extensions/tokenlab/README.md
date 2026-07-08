# OpenClaw TokenLab Provider

Official OpenClaw provider plugin for TokenLab through its OpenAI-compatible API.

Install from OpenClaw:

```bash
openclaw plugins install @openclaw/tokenlab-provider
openclaw gateway restart
```

Configure a TokenLab API key, then select models with refs such as
`tokenlab/gpt-5.5`, `tokenlab/claude-sonnet-5`, or `tokenlab/gemini-3.5-flash`.

TokenLab also exposes native Responses, Anthropic Messages, and Gemini
generateContent formats. This plugin uses the OpenAI-compatible chat route for
OpenClaw model execution.
