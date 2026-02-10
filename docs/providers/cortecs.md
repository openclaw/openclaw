---
summary: "Use Cortecs's unified API to access various EU compliant models in OpenClaw"
read_when:
  - You want an EU compliant infrastructure for your LLMs
  - You want to run models via a single API key in OpenClaw
---

# Cortecs Gateway

Cortecs is an AI inference platform designed for strict European data compliance. It provides a gateway to run large language models across a sovereign, scalable, and privacy-first network.

Source: [Cortecs Gateway](https://docs.cortecs.ai/)

## Model overview

Built on the principles of Sky Computing, Cortecs provides access to multiple models across various cloud providers.

On our website you can find all our available [models](https://cortecs.ai/serverlessModels).

The recommended model is **gpt-oss-120b**, a powerful 120 billion parameter model made by OpenAI. Which is provided by various European cloud providers such as Scaleway, OVHcloud, and Nebius.

## Setup

### Quick start

Configure via CLI:

```bash
clawdbot onboard --auth-choice cortecs-api-key
```

Or set the API key manually:

```bash
export CORTECS_API_KEY="your-api-key-here"
```

### Config snippet

```json5
{
  agents: {
    defaults: {
      model: { primary: "cortecs/gpt-oss-120b" },
    },
  },
}
```

## Notes

- Model refs use `cortecs/<model>` format.
- Your data is not reused or kept by Cortecs; data privacy is guaranteed.
