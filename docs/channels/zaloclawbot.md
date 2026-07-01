---
summary: "Zalo ClawBot channel setup through the external openclaw-zaloclawbot plugin"
read_when:
  - You want a personal Zalo assistant bot with QR-code login
  - You are installing or troubleshooting the openclaw-zaloclawbot channel plugin
title: "Zalo ClawBot"
---

OpenClaw connects to Zalo ClawBot through the catalog-listed external
`@zalo-platforms/openclaw-zaloclawbot` plugin. Login uses a Zalo Mini App QR
code.

## Compatibility

| Plugin Version | OpenClaw Version | npm dist-tag | Status        |
| -------------- | ---------------- | ------------ | ------------- |
| 0.1.x          | >=2026.4.10      | `latest`     | Active / Beta |

## Prerequisites

- Node.js **>= 22**
- [OpenClaw](https://docs.openclaw.ai/install) must be installed (`openclaw` CLI available).
- A Zalo account on a mobile device to scan the login QR code.

## Install with onboard (recommended)

Run the OpenClaw onboarding wizard and pick **Zalo ClawBot** from the channel menu:

```bash
openclaw onboard
```

The wizard installs the plugin from the official catalog (integrity-verified), renders the login QR right in the terminal, and finishes the channel once you scan it with the Zalo app. No extra commands are needed.

## Manual Installation

To add the channel to an already-onboarded gateway, follow these steps:

### 1. Install the plugin

```bash
openclaw plugins install "@zalo-platforms/openclaw-zaloclawbot@0.1.4"
```

Use the exact pinned version shown above (it matches the official catalog entry), so OpenClaw verifies the package against the catalog integrity hash during install.

### 2. Enable the plugin in config

```bash
openclaw config set plugins.entries.openclaw-zaloclawbot.enabled true
```

### 3. Generate QR code and log in

```bash
openclaw channels login --channel openclaw-zaloclawbot
```

Scan the terminal-rendered QR code using the Zalo mobile app, accept the Terms of Use inside the Zalo Mini App, and authorize the session.

### 4. Restart the gateway

```bash
openclaw gateway restart
```

---

## How It Works

Unlike the standard developer Zalo channel which requires you to register your own Zalo Official Account (OA) and paste static developer credentials, Zalo ClawBot operates as an **owner-bound personal assistant** using a shared, official infrastructure:

1. **Secure Onboarding:** The QR code resolves to a secure Zalo Mini App that binds a newly-provisioned, private bot under a shared official OA directly to your Zalo User ID.
2. **Owner-Bound Privacy:** By design, the bot is restricted to communicating _only_ with its owner. Messages from other users are dropped at the platform level, making the connection private and secure.
3. **Official API path:** The plugin uses Zalo Bot Platform APIs instead of
   browser or web-session automation.

## Under the Hood

The Zalo ClawBot plugin communicates with Zalo APIs via a persistent long-polling message loop. To maintain a clean and lightweight runtime:

- Long-poll connections utilize the `getUpdates` endpoint.
- Webhooks are disabled by default for local desktop/terminal gateway runs.
- Messages are processed client-side and mapped directly to your local agent runtime.

The external plugin manages bot credentials under the OpenClaw state directory.
Treat that directory as sensitive and include it in the same access-control and
backup policy as the rest of your OpenClaw state.

---

## Troubleshooting

- **QR Login Timeout:** The login token (`zbsk`) expires after 5 minutes for security reasons. If the QR code expires before you scan it, simply rerun the login command to generate a new one.
- **Gateway Fails to Load:** Ensure your OpenClaw host version is `2026.4.10` or higher. Older versions do not support the external npm-plugin installation ledger.
