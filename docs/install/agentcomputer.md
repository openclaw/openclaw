---
summary: "Run OpenClaw on an Agent Computer managed worker and expose it through a published host"
read_when:
  - You want OpenClaw on Agent Computer
  - You want a cloud Linux machine with SSH, durable home storage, and published web access
title: "Agent Computer"
---

# Agent Computer

Goal: OpenClaw Gateway running on an Agent Computer managed worker, reachable from your browser through a published host.

This guide uses the Agent Computer CLI to create a managed worker, installs OpenClaw inside it, then publishes port `18789` so the Control UI can be reached remotely.

## Beginner quick path

1. `npm install -g aicomputer`
2. `computer login`
3. `computer create my-openclaw`
4. `computer ssh my-openclaw`
5. `curl -fsSL https://openclaw.ai/install.sh | bash`
6. `openclaw onboard --install-daemon`
7. `openclaw doctor --generate-gateway-token`
8. `openclaw config set gateway.bind lan`
9. `openclaw gateway restart`
10. `computer ports publish my-openclaw 18789 --subdomain openclaw`
11. Open the published URL and paste the token from `openclaw config get gateway.auth.token`

## What you need

- Agent Computer account
- Node.js on your local machine so you can install `aicomputer`
- A model provider key or other auth required by your OpenClaw onboarding flow

## 1) Install the Agent Computer CLI and sign in

On your local machine:

```bash
npm install -g aicomputer
computer login
```

The login flow opens a browser, stores an Agent Computer API key locally, and prepares SSH access for later steps.

## 2) Create the machine

On your local machine:

```bash
computer create my-openclaw
computer ssh my-openclaw
```

Tip: Agent Computer keeps the machine home directory at `/home/node`, so OpenClaw state under `~/.openclaw/` persists across reconnects and power cycles.

## 3) Install OpenClaw

Inside the Agent Computer shell:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw --version
```

## 4) Run onboarding

Inside the Agent Computer shell:

```bash
openclaw onboard --install-daemon
```

If the machine reports that systemd user services are unavailable, rerun onboarding without the daemon install and keep the gateway running in `tmux` instead:

```bash
openclaw onboard
tmux new-session -d -s openclaw 'openclaw gateway run'
```

## 5) Bind the gateway for published-port access

Agent Computer published ports reach the machine over its service network path, so the default loopback bind is not enough. OpenClaw must listen on a non-loopback interface before you publish port `18789`.

Inside the Agent Computer shell:

```bash
openclaw doctor --generate-gateway-token
openclaw config set gateway.bind lan
openclaw gateway restart
```

If you are using the `tmux` fallback instead of a service, restart the `tmux` session rather than `openclaw gateway restart`.

## 6) Publish the OpenClaw port

Back on your local machine:

```bash
computer ports publish my-openclaw 18789 --subdomain openclaw
```

Agent Computer will print the published host. If you need to retrieve it again later:

```bash
computer ports ls my-openclaw
```

## 7) Access OpenClaw and finish pairing

Open the published host from the previous step. If OpenClaw prompts for auth, retrieve the gateway token from the machine:

```bash
openclaw config get gateway.auth.token
```

Then approve any pairing requests:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

Agent Computer browser auth and OpenClaw gateway auth are separate. Reaching the published host gets you to the machine; OpenClaw may still require its own token or pairing approval.

## Updating

Inside the Agent Computer shell:

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
```

If you used the `tmux` fallback, restart the gateway in `tmux` after updating.

## Power and persistence

- `computer power-off my-openclaw` stops the managed worker without deleting its durable home.
- `computer power-on my-openclaw` recreates the runtime against the same stored home directory.
- Published hosts only work while the machine is running.
- If you did not install a daemon, reconnect after power-on and start the gateway again.
