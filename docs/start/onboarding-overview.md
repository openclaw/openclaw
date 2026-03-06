---
summary: "Overview of OpenClaw onboarding options and flows"
read_when:
  - Choosing an onboarding path
  - Setting up a new environment
title: "Onboarding Overview"
sidebarTitle: "Onboarding Overview"
---

# Onboarding Overview

OpenClaw supports multiple onboarding paths depending on where the Gateway runs
and how you prefer to configure providers.

## Choose your onboarding path

- **CLI wizard** for macOS, Linux, and Windows (via WSL2).
- **macOS app** for a guided first run on Apple silicon or Intel Macs.

## CLI onboarding wizard

Run the wizard in a terminal:

```bash
openclaw onboard
```

Use the CLI wizard when you want full control of the Gateway, workspace,
channels, and skills. Docs:

- [Onboarding Wizard (CLI)](/start/wizard)
- [`openclaw onboard` command](/cli/onboard)

## macOS app onboarding

Use the OpenClaw app when you want a fully guided setup on macOS. Docs:

- [Onboarding (macOS App)](/start/onboarding)

## Custom Provider

If you need an endpoint that is not listed, including hosted providers that
expose standard OpenAI or Anthropic APIs, choose **Custom Provider** in the
CLI wizard. You will be asked to:

- Pick OpenAI-compatible, Anthropic-compatible, or **Unknown** (auto-detect).
- Enter a base URL and API key (if required by the provider).
- Provide a model ID and optional alias.
- Choose an Endpoint ID so multiple custom endpoints can coexist.

For detailed steps, follow the CLI onboarding docs above.

## Local Server Provider

If your inference server exposes a **fully custom (non-standard) API** — such
as a uvicorn/FastAPI server, a research prototype, or any HTTP endpoint you
control — choose **Local Server Provider** in the CLI wizard:

```bash
openclaw onboard --auth-choice local-server
```

You will be asked to:

- Enter the endpoint URL (e.g. `http://192.168.1.10:8000/infer`).
- Provide a JSON request body **template** with placeholders like `{{prompt}}`.
- Specify a **response path** to extract the generated text (e.g. `response`, `result.text`).
- Optionally enter an API key and custom headers.

See [Model providers — Local Server](/concepts/model-providers#local-server-fully-custom-endpoint) for full configuration details.
