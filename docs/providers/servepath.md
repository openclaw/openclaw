---
summary: "Use Servepath's unified API gateway in OpenClaw"
read_when:
  - You want one API key for Servepath routing
  - You want to use the short `servepath` route in OpenClaw
title: "Servepath"
---

# Servepath

Servepath is a unified OpenAI-compatible gateway. In OpenClaw, the bundled
Servepath provider gives you one API key, one base URL, and a default routed
model route.

Use it when you want OpenClaw to talk to Servepath directly instead of configuring
a generic custom OpenAI-compatible provider by hand.

Most users should think of the default route as `servepath`.
OpenClaw stores the canonical provider/model ref as `servepath/all` and wires the
friendlier alias `servepath` to that route for you.

## CLI setup

```bash
openclaw onboard --auth-choice servepath-api-key
```

## Config snippet

```json5
{
  env: { SERVEPATH_API_KEY: "ts-..." },
  agents: {
    defaults: {
      model: { primary: "servepath/all" },
      models: {
        "servepath/all": { alias: "servepath" },
      },
    },
  },
}
```

In other words:

- Friendly shorthand: `servepath`
- Canonical stored ref: `servepath/all`

## What setup configures

After onboarding, OpenClaw treats Servepath as provider `servepath` and uses the
hosted base URL `https://api.servepath.ai`.

- Friendly alias: `servepath`
- Canonical routed ref: `servepath/all`
- Explicit passthrough refs also work, for example:
  - `servepath/anthropic/claude-sonnet-4-6`
  - `servepath/openai/gpt-5.4`

## Explicit provider config

If you prefer to manage the provider block yourself instead of using onboarding,
this shape is sufficient:

```json5
{
  models: {
    providers: {
      servepath: {
        baseUrl: "https://api.servepath.ai",
        apiKey: "${SERVEPATH_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "all",
            name: "Servepath Router (alias: servepath)",
            input: ["text", "image"],
            reasoning: false,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Notes

- User-facing shorthand is `servepath`.
- OpenClaw stores the canonical routed ref as `servepath/all`.
- Servepath uses the OpenAI-compatible transport under the hood.
- The default routed model can accept text and image inputs; Servepath chooses a
  compatible downstream model at runtime.
- If you want a specific upstream model, switch to an explicit routed ref later.
