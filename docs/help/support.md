---
summary: "Official OpenClaw support, safe diagnostics, and separate bug and security reporting routes"
read_when:
  - You need help with OpenClaw setup or a problem the docs did not resolve
  - You want to know where to ask for support or report a bug
  - You are preparing diagnostics to share
title: "Get support"
---

For official OpenClaw support, visit [community.openclaw.ai](https://community.openclaw.ai/).

## Start with self-service help

- [Getting started](/start/getting-started) for installation and onboarding.
- [Troubleshooting](/help/troubleshooting) for a symptom-first diagnosis.
- [FAQ](/help/faq) for common setup and operational questions.
- [Gateway troubleshooting](/gateway/troubleshooting) for connection and service issues.

If those guides do not resolve your problem, use **Support** or **Get support** in the app, or visit the support site above. Discord remains a place for social chat and contributor coordination, not the official support destination.

## What to include

Describe what you were trying to do, what happened, what you expected, and the smallest steps that reproduce the problem. Include your OpenClaw version, operating system, installation method, and relevant error text.

Useful diagnostics include:

```bash
openclaw status --all
openclaw gateway status --deep
```

[OpenClaw triage](/cli/triage) can collect a diagnosis and support archive. Review all diagnostics, screenshots, and archives before posting: remove credentials, tokens, private messages, and other personal information. Do not post your full configuration or state directory.

## Bugs and security reports

- **Reproducible product defects and documentation bugs:** use the [GitHub issue chooser](https://github.com/openclaw/openclaw/issues/new/choose), with reproduction steps and relevant evidence. Setup questions belong on the support site rather than in GitHub issues.
- **Security vulnerabilities:** follow the private reporting instructions in [SECURITY.md](https://github.com/openclaw/openclaw/blob/main/SECURITY.md). Do not post vulnerability details in public support topics or public GitHub issues.
