---
summary: "Run OpenClaw on Clawcks managed hosting"
read_when:
  - You want hosted OpenClaw without managing a server
  - You want browser-based setup and CLI access
title: "Clawcks"
---

# Clawcks

Run OpenClaw on Clawcks.

Clawcks hosts OpenClaw for you. It is an opinionated hosting option focused on ease of use. You do not need to set up a server, Docker, Kubernetes, networking, storage, or a process manager.

## Credential trust

Clawcks is independent and not affiliated with OpenClaw. Because Clawcks runs the Gateway for you, the credentials you enter during onboarding are handled by Clawcks.

Use Clawcks only if you are comfortable trusting Clawcks with your OpenAI API key, Telegram bot token, hosted Gateway state, and any data handled by that Gateway. Use another install option if you want those credentials and data to stay on infrastructure you control.

The onboarding flow guides you through setup. You need an OpenAI API key and a Telegram bot token. Clawcks shows you how to create the Telegram bot during onboarding.

Clawcks also provides a web-based CLI, so you can control the agent from the browser.

## What you need

- An OpenAI API key
- A Telegram bot token

The OpenAI API key is needed for onboarding. After setup, you can switch OpenClaw to any supported model provider and any supported agent harness, including Codex.

## Deploy

Go to [clawcks.com](https://clawcks.com) and follow the onboarding steps.

When setup finishes, Clawcks keeps the OpenClaw Gateway running for you.

## When to use Clawcks

Use Clawcks if you want to run OpenClaw without managing hosting yourself.

Use another install option if you want to control the server, container image, network, filesystem, and deployment process.

## Notes

- Clawcks runs a hosted OpenClaw Gateway.
- Your local machine does not need to stay on.
- The Telegram setup is part of onboarding.
- The web-based CLI gives direct control over the agent from the browser.
- Clawcks is opinionated and focuses on ease of use.
