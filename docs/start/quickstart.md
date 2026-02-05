---
summary: "Install OpenClaw, onboard the Gateway, and pair your first channel."
read_when:
  - You want the fastest path from install to a working Gateway
title: "Quick start"
---

<Note>
OpenClaw requires Node 22 or newer.
</Note>

## Install

<Tabs>
  <Tab title="npm">
    ```bash
    npm install -g openclaw@latest
    ```
  </Tab>
  <Tab title="pnpm">
    ```bash
    pnpm add -g openclaw@latest
    ```
  </Tab>
</Tabs>

## Onboard and run the Gateway

<Steps>
  <Step title="Onboard and install the service">
    ```bash
    openclaw onboard --install-daemon
    ```
  </Step>
  <Step title="Pair WhatsApp">
    ```bash
    openclaw channels login
    ```
  </Step>
  <Step title="Start the Gateway">
    ```bash
    openclaw gateway --port 18789
    ```
  </Step>
</Steps>

After onboarding, the Gateway runs via the user service. You can still run it manually with `openclaw gateway`.

<Info>
Switching between npm and git installs later is easy. Install the other flavor and run
`openclaw doctor` to update the gateway service entrypoint.
</Info>

## From source (development)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard --install-daemon
```

If you do not have a global install yet, run onboarding via `pnpm openclaw ...` from the repo.

## Multi instance quickstart (optional)

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json \
OPENCLAW_STATE_DIR=~/.openclaw-a \
openclaw gateway --port 19001
```

## Send a test message

Requires a running Gateway.

```bash
openclaw message send --target +15555550123 --message "Hello from OpenClaw"
```
