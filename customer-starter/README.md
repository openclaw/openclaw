# OpenClaw customer starter

A **starting point for a new customer** deployment: multi-user context (one bot, many users with per-user preferences) and straightforward **Telegram** and **WhatsApp** user onboarding.

This repo is **self-contained**: config templates, deployment env, and scripts to copy config to a GCP VM and start the container via SSH. No need to clone the main OpenClaw repo on your laptop.

---

## Workflow: commit → clone → customize → deploy

1. **Commit this repo to your GitHub** (e.g. push `customer-starter` as its own repo, or “Use this template” to create `YOUR_ORG/openclaw-customer-starter`).
2. **On your Mac**, create a new directory and clone that repo:
   ```bash
   mkdir -p ~/deploys && cd ~/deploys
   git clone https://github.com/YOUR_ORG/openclaw-customer-starter.git firstlight-openclaw
   cd firstlight-openclaw
   ```
3. **Customize**: copy `deployment.example.env` → `deployment.env` and `config/openclaw.example.yml` → `config/openclaw.yml`, then edit (GCP VM, container name, Telegram token, WhatsApp, etc.). See [SETUP.md](SETUP.md) for the full walkthrough.
4. **Deploy**: run `./scripts/copy-config-to-vm.sh` to push config to the VM, then `./scripts/start-on-vm.sh` to start the container. Use `./scripts/vm-ssh.sh` to run commands on the VM.

**Requirements:** `gcloud` CLI, a GCP VM with Docker and the main OpenClaw repo (or image) set up. We deploy **from your machine**; customization stays local.

---

## Start here: guided setup

**Walk through the setup with your assistant (or follow the steps yourself):**

👉 **[SETUP.md](SETUP.md) — Guided setup (step-by-step)**

Each step has a **Checkpoint**; when you’re done, tell your assistant and they’ll guide you to the next step. You’ll end up with a working config, Telegram and WhatsApp enabled, and your first user in `session.identityLinks`.

---

## Purpose

- Use this repo as a **template**: clone it (or "Use this template" on GitHub), then customize for a specific customer (e.g. FirstLight).
- It does **not** contain the OpenClaw app code. You run OpenClaw (or your fork) separately; this repo holds **config**, **docs**, and **checklists** for the customer setup.
- After customizing, point your OpenClaw gateway at this repo’s config (or copy the config into your OpenClaw deploy).

## Multi-user context and OpenClaw updates

**Multi-user context** (`session.dmScope`, `session.identityLinks`) is implemented in the **OpenClaw app** (main repo), not in this starter. This repo only provides the config and docs that use those features—no code changes required for basic multi-user.

If you need to **modify OpenClaw** (e.g. add an extension, a custom inject plugin, or change the system prompt) and still stay up to date with upstream: **fork** the [OpenClaw repo](https://github.com/openclaw/openclaw), add `upstream` as a remote, do your changes on a branch, and periodically run `git fetch upstream && git merge upstream/main`. Deploy from your fork on the VM; this starter’s config still points at the same gateway. See [Multi-user context and keeping OpenClaw up to date](https://docs.openclaw.ai/reference/multi-user-and-upstream) and [Fork and deploy plan](https://docs.openclaw.ai/reference/fork-and-deploy-plan).

## What’s inside

| Path                            | Description                                                                                                                                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SETUP.md**                    | **Guided setup** — step-by-step walkthrough (GCP VM + Docker); do one step, then tell your assistant and continue.                                                                                                      |
| **deployment.example.env**      | GCP VM, container name, and paths. Copy to `deployment.env` and fill in; scripts use it for SSH and deploy.                                                                                                             |
| `config/`                       | Example OpenClaw config: session (dmScope, identityLinks), Telegram, WhatsApp. Copy to `openclaw.yml` and edit.                                                                                                         |
| **scripts/**                    | `vm-ssh.sh` (SSH to VM), `copy-config-to-vm.sh` (push config), `start-on-vm.sh` (start container). Run from repo root.                                                                                                  |
| **plugin/user-context-inject/** | Inject plugin for multi-user context: reads `users/<key>.md`, injects as prependContext. Copy to workspace `.openclaw/extensions/user-context-inject/` and add to `plugins.allow`.                                      |
| `docs/`                         | Multi-user-context checklist, adding users (Telegram + WhatsApp), [review](docs/MULTI-USER-REVIEW.md), [AGENTS snippet](docs/AGENTS-SNIPPET-multi-user.md), [adding skills and tools](docs/ADDING-SKILLS-AND-TOOLS.md). |
| **CUSTOMIZE.md**                | Short reference: clone → rename for customer → fill config → deploy.                                                                                                                                                    |

## Quick start (if you prefer to do it without the guide)

1. **Clone this repo** (or create a new repo from it on GitHub):
   ```bash
   git clone https://github.com/YOUR_ORG/openclaw-customer-starter.git firstlight-openclaw
   cd firstlight-openclaw
   ```
2. **Customize** for the customer: rename in README, set `config/openclaw.example.yml` (or `.json`) with bot tokens, channel ids, and leave `session.identityLinks` empty at first.
3. **Deploy OpenClaw** (Docker or your fork) and set `OPENCLAW_CONFIG_DIR` (or copy `config/` contents) to this repo’s config so the gateway uses it.
4. **Enable Telegram and WhatsApp**: add bot token (Telegram), run `openclaw channels login` (WhatsApp), then add users (see [Adding users (Telegram + WhatsApp)](docs/ADDING-USERS.md)).
5. **Add users** one by one: allowlist or pairing, then add each user to `session.identityLinks` so they get one session and one prefs file across channels (see [Multi-user context](docs/MULTI-USER-CONTEXT.md)).

## Links

- [OpenClaw docs](https://docs.openclaw.ai) — Gateway, channels, config.
- [Multi-user context](https://docs.openclaw.ai/concepts/multi-user-context) — Per-user preferences and identity links.
- [Telegram](https://docs.openclaw.ai/channels/telegram) · [WhatsApp](https://docs.openclaw.ai/channels/whatsapp) — Channel setup and peer id format.

## Pushing this repo to your GitHub

This folder is a **clean, standalone repo** you can commit and push:

1. Create a new repo on GitHub (e.g. `YOUR_ORG/openclaw-customer-starter`). Do **not** initialize with a README.
2. Copy this folder to a new directory (so it’s not inside the OpenClaw repo), then init and push:
   ```bash
   cp -r /path/to/openclaw/customer-starter /tmp/openclaw-customer-starter
   cd /tmp/openclaw-customer-starter
   git init
   git add .
   git commit -m "Initial customer starter template"
   git remote add origin https://github.com/YOUR_ORG/openclaw-customer-starter.git
   git branch -M main
   git push -u origin main
   ```
3. Optionally enable **Template repository** in the repo settings so you can “Use this template” for each new customer.
4. **Your workflow:** On your Mac, create a new dir, clone the repo you just pushed, customize `deployment.env` and `config/openclaw.yml`, then run the scripts to deploy (see “Workflow” above).

## License

Same as the OpenClaw project (see root repo).
