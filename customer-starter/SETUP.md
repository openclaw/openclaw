# Guided setup (walk through with your assistant)

Use this page **one step at a time**. After each step, tell your assistant you’re done (or paste any output) and they’ll guide you to the next step.

**With an AI assistant (e.g. in Cursor):** Open this repo, then say: _“Walk me through the customer-starter setup”_ or _“I’m at Step N, done.”_ The assistant will use this file to guide you step by step.

---

## Before you start

- We’re installing OpenClaw as a **Docker container on a named GCP VM**. You’ll supply the VM details (project, VM name, zone) and the container/service name during setup.
- You’re setting up for **one customer** (e.g. FirstLight). Pick a short **customer name** (e.g. `firstlight`) for folder and config.
- You have (or will create) a **GCP VM** with Docker installed and the OpenClaw image available (from the [OpenClaw repo](https://github.com/openclaw/openclaw) or your fork). Your assistant can help with VM creation and Docker install if needed.

---

## Step 1 — Clone the repo

Clone this repo into a folder named after your customer (or any name you prefer).

```bash
git clone https://github.com/YOUR_ORG/openclaw-customer-starter.git firstlight-openclaw
cd firstlight-openclaw
```

**If you used “Use this template” on GitHub**, clone the new repo you created instead:

```bash
git clone https://github.com/YOUR_ORG/your-customer-repo.git firstlight-openclaw
cd firstlight-openclaw
```

**Checkpoint:** You’re in the repo and `config/openclaw.example.yml` and `docs/` exist. Tell your assistant: “Step 1 done.”

---

## Step 2 — Create your config file

Create the real config file from the example. We’ll edit it in the next steps; it’s ignored by git so you won’t commit secrets.

```bash
cp config/openclaw.example.yml config/openclaw.yml
```

**Checkpoint:** `config/openclaw.yml` exists. Tell your assistant: “Step 2 done.”

---

## Step 3 — Record deployment target (GCP VM + Docker)

We need to know **where** this customer’s OpenClaw will run: which GCP VM and which Docker container name. Your assistant will use this to give you the right commands and can run commands on the VM for you (e.g. via SSH).

1. Copy the deployment example and fill in your values:
   ```bash
   cp deployment.example.env deployment.env
   ```
2. Edit **`deployment.env`** and set:
   - **GCP_VM_PROJECT**, **GCP_VM_NAME**, **GCP_VM_ZONE** — GCP VM (e.g. `gidr-demo`, `openclaw-gateway`, `us-central1-a`).
   - **OPENCLAW_CONTAINER_NAME** — Docker service/container name for this customer (e.g. `gidr-claw-firstlight`). Must match the service in your OpenClaw multi-instance compose.
   - **OPENCLAW_ON_VM_PATH** — Path on the VM where this customer’s folder lives (e.g. `/home/user/firstlight-openclaw`). Scripts copy `config/` here.
   - **OPENCLAW_REPO_ON_VM_PATH** — Path on the VM to the main OpenClaw repo (e.g. `/home/user/openclaw`). Used by `scripts/start-on-vm.sh`.

`deployment.env` is gitignored so you don’t commit internal names or project ids. Your assistant can read it from your workspace to run VM SSH or suggest exact docker/compose commands.

**Checkpoint:** `deployment.env` exists with correct `GCP_VM_*` and `OPENCLAW_CONTAINER_NAME`. Tell your assistant: “Step 3 done.”

---

## Step 4 — Set customer name and session (multi-user)

Open `config/openclaw.yml` and confirm:

- `session.dmScope` is `per-peer` (one session per person across Telegram and WhatsApp).
- `session.identityLinks` is `{}` (we’ll add users later).

No need to change anything yet unless you want to add a comment with your customer name at the top of the file.

**Checkpoint:** You’ve looked at `config/openclaw.yml` and see `session:` with `dmScope: per-peer` and `identityLinks: {}`. Tell your assistant: “Step 4 done.”

---

## Step 5 — Telegram: create bot and add token

1. In Telegram, open [@BotFather](https://t.me/BotFather) and create a new bot (`/newbot`). Copy the **token**.
2. Open `config/openclaw.yml` and set the Telegram token:
   - Under `channels.telegram`, set `botToken: "YOUR_TOKEN"` (or leave empty and set env `TELEGRAM_BOT_TOKEN` later).
3. Leave `dmPolicy: pairing` so new users get a pairing code, or set `dmPolicy: allowlist` and `allowFrom: []` if you’ll add user ids later.

**Checkpoint:** `channels.telegram.botToken` is set (or you’ve noted you’ll use env). Tell your assistant: “Step 5 done.”

---

## Step 6 — WhatsApp: decide number and policy

1. Decide which **phone number** will be used for WhatsApp (dedicated number or WhatsApp Business recommended).
2. In `config/openclaw.yml`, under `channels.whatsapp`:
   - Set `dmPolicy: allowlist` and `allowFrom: []` for now (we’ll add numbers when we add users), **or**
   - Set `dmPolicy: pairing` if you want unknown senders to get a pairing code.
3. You’ll run `openclaw channels login` and scan the QR code **after** the gateway is running (later step).

**Checkpoint:** `channels.whatsapp` has `dmPolicy` and `allowFrom` (or pairing) set. Tell your assistant: “Step 6 done.”

---

## Deployment flow: deploy from here, customize locally

We **deploy from your machine** and **manage customization locally**: this repo (and `config/`, `deployment.env`) stays on your laptop or in Cursor. You edit here; you (or the assistant) copy config to the VM when needed and run Docker on the VM via SSH (e.g. `vm-ssh.sh`). No need to clone this customer repo on the VM for day-to-day edits.

(Alternative: you can instead clone this repo on the VM and customize there; Step 7 has a short “Alternative: clone and customize on the VM” section if you prefer that.)

---

## Step 7 — Deploy OpenClaw as Docker on the GCP VM

OpenClaw runs as a **Docker container on the VM** in `deployment.env`. The container must use this customer’s **config** so the gateway loads `openclaw.yml`.

### Deploy from here (default)

1. **Set paths in `deployment.env`** (you did this in Step 3). Ensure `OPENCLAW_ON_VM_PATH` and `OPENCLAW_REPO_ON_VM_PATH` are set (see `deployment.example.env`).
2. **Copy this customer’s config to the VM** (whenever you change config). From this repo root:
   ```bash
   ./scripts/copy-config-to-vm.sh
   ```
3. **On the VM**, the main OpenClaw repo must already be at `OPENCLAW_REPO_ON_VM_PATH` with compose and `.env` set. In that `.env`, set the **config dir** for this customer’s container (e.g. `OPENCLAW_FIRSTLIGHT_CONFIG_DIR=/home/user/firstlight-openclaw/config` to match `OPENCLAW_ON_VM_PATH` + `/config`).
4. **Start (or restart) the container** from this repo root:
   ```bash
   ./scripts/start-on-vm.sh
   ```
5. **Confirm:** `./scripts/vm-ssh.sh -- 'docker ps'` and check the container is up.

### Alternative: clone and customize on the VM

If you prefer to keep everything on the server: SSH to the VM, clone this repo (or your customer repo) there, edit `config/openclaw.yml` on the VM, set the OpenClaw `.env` config path (e.g. `OPENCLAW_FIRSTLIGHT_CONFIG_DIR=...`), then run `./platforms/gcp-vm/manage-multi.sh start` (or the relevant `docker compose ... up -d` command) on the VM.

**Checkpoint:** Gateway container is running on the GCP VM and loading config from this customer’s `config/`. Tell your assistant: “Step 7 done.”

---

## Step 8 — WhatsApp: link the number (if using WhatsApp)

If you’re using WhatsApp:

1. Run **`openclaw channels login`** (from the same machine or container that runs the gateway, with the same config).
2. Scan the QR code with the phone that has the number you chose for WhatsApp.
3. After linking, the gateway keeps the session; keep the gateway running so the session stays active.

**Checkpoint:** WhatsApp shows “Linked devices” and the OpenClaw session is active. Tell your assistant: “Step 8 done.”

---

## Step 9 — Add your first user (identityLinks)

1. Have the **first user** send one message to your Telegram bot (or WhatsApp number) so the gateway sees them.
2. Get their **peer id**:
   - **Telegram:** numeric user id (e.g. from gateway logs, or ask your assistant how to find it).
   - **WhatsApp:** E.164 number (e.g. `+15551234567`).
3. Choose a **canonical id** for them (e.g. `alice`, `jane`, `firstlight-ops-1`). This will be their session key suffix and the base for their prefs file.
4. Open `config/openclaw.yml` and add them under `session.identityLinks`:

   ```yaml
   session:
     dmScope: per-peer
     identityLinks:
       alice: ["telegram:123456789"] # use real telegram user id
       # or for WhatsApp: alice: ["whatsapp:+15551234567"]
       # or both:        alice: ["telegram:123456789", "whatsapp:+15551234567"]
   ```

5. Save the file. The gateway hot-reloads config; no restart needed.

**Checkpoint:** The user is in `identityLinks`. They send another message; it should be handled under session `agent:main:dm:alice` (or your canonical id). Tell your assistant: “Step 9 done.”

---

## Step 10 — Optional: per-user preferences (inject plugin)

To have the bot remember per-user details (timezone, preferences) in a file per user:

1. In the **agent workspace** on the VM, create a `users/` directory (or let the agent create it on first write).
2. **Copy the inject plugin** from this repo to the workspace so OpenClaw loads it:
   - From this repo: `plugin/user-context-inject/` (openclaw.plugin.json + index.ts).
   - On the VM, copy it to: `<workspace>/.openclaw/extensions/user-context-inject/` (same structure). The workspace path is the one your gateway uses (e.g. the default or `agents.defaults.workspace` in config).
3. **Enable the plugin** in `config/openclaw.yml`: add under `plugins` (create the key if missing): `allow: [telegram, whatsapp, user-context-inject]` (include whichever channel plugins you use). No OpenClaw code changes or fork needed—the plugin is in this repo.
4. In **AGENTS.md** (or SOUL.md) in the workspace, add instructions so the agent writes user preferences to `users/<key>.md`. Use the snippet in [docs/AGENTS-SNIPPET-multi-user.md](docs/AGENTS-SNIPPET-multi-user.md).

**Checkpoint:** Plugin is registered and one user file exists (or the agent has created it). Tell your assistant: “Step 10 done.”

---

## Step 11 — Optional: custom skills and tools

If your use case needs **custom tools** (e.g. search a knowledge base, call an API) and **skills** with business rules for when and how to call them:

1. **Tools** — Add or enable an extension/plugin that registers the tools (e.g. in the OpenClaw repo you run or your fork). In config, allowlist the tool names (e.g. `tools.alsoAllow: ["search_troubleshooting", "retrieval_firstlight_noc"]`) and set any required env vars.
2. **Skill** — Add a `SKILL.md` in the agent workspace at `skills/<name>/SKILL.md` (or use `skills.load.extraDirs` in config). In the skill, describe the tools, **when to use** them, **behavior** (order, citations, handling no results), and setup.
3. **Business rules** — Put “when to use” and “behavior” in the skill; optionally reinforce in AGENTS.md or SOUL.md.

Full guide: [Adding skills and tools for a custom use case](docs/ADDING-SKILLS-AND-TOOLS.md) (e.g. FirstLight: two tools + skill + rules).

**Checkpoint:** Custom tools are allowlisted, skill is in place, and the agent follows the rules. Tell your assistant: “Step 11 done.”

---

## You’re done

- **Add more users:** Repeat Step 9 for each person; add Telegram and/or WhatsApp peer ids to their `identityLinks` entry.
- **Existing user adds a second channel:** Append the new peer id to their existing entry (e.g. add `whatsapp:+15551234567` to `alice`).
- **Reference:** [Adding users (Telegram + WhatsApp)](docs/ADDING-USERS.md) · [Multi-user context](docs/MULTI-USER-CONTEXT.md) · [Adding skills and tools](docs/ADDING-SKILLS-AND-TOOLS.md).

If you get stuck on any step, tell your assistant which step and what you see (error message, config snippet, or “I don’t have X yet”); they can guide you through it.
