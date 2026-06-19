---
summary: "OpenClaw Anthropic Vertex provider plugin for Claude models on Google Vertex AI."
read_when:
  - You are installing, configuring, or auditing the anthropic-vertex plugin
title: "Anthropic Vertex plugin"
---

# Anthropic Vertex plugin

OpenClaw Anthropic Vertex provider plugin for Claude models on Google Vertex AI.

## Distribution

- Package: `@openclaw/anthropic-vertex-provider`
- Install route: npm; ClawHub

## Surface

providers: anthropic-vertex

<!-- openclaw-plugin-reference:manual-start -->

## Claude Fable 5

Use `anthropic-vertex/claude-fable-5` where the model is available in your Google Cloud region.
Fable 5 always uses adaptive thinking and defaults to `high` effort. `/think off` and
`/think minimal` use `low` effort because the model does not support disabling thinking.

<!-- openclaw-plugin-reference:manual-end -->
