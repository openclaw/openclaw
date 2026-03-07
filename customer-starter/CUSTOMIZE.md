# Customize for a customer

Use this repo as the base for a **specific customer** (e.g. FirstLight). Clone once per customer and tailor config and docs.

## 1. Clone and rename

```bash
git clone https://github.com/YOUR_ORG/openclaw-customer-starter.git firstlight-openclaw
cd firstlight-openclaw
```

(Or create a new repo from the template on GitHub, then clone that.)

## 2. Customer-specific renames

- **README**: Update the "Quick start" example to use the customer name (e.g. FirstLight).
- **Config**: Copy `config/openclaw.example.yml` to `config/openclaw.yml` (or your OpenClaw config path) and set:
  - Gateway token, agent id, workspace paths if needed.
  - Telegram `botToken`, WhatsApp accounts if any.
  - Leave `session.identityLinks` as `{}` and add users as they onboard.

Do **not** commit real tokens or phone numbers. Use env vars or a secrets store and reference them from config where supported, or keep `openclaw.yml` out of git (add to `.gitignore`) and maintain it on the deploy host.

## 3. Deploy OpenClaw

We deploy **from here** (this repo stays on your machine). Copy this repo’s `config/` to the VM (e.g. rsync), then run OpenClaw in Docker on the VM via SSH (e.g. `vm-ssh.sh` from the main repo using `deployment.env`). See SETUP.md Step 7.

- Run OpenClaw (from the [main repo](https://github.com/openclaw/openclaw) or your fork) via Docker on the GCP VM.
- Set **OPENCLAW_CONFIG_DIR** (or the compose instance env) on the VM to the path where you copied this repo’s `config/` (so the gateway loads `openclaw.yml`).
- Ensure the agent **workspace** exists and is writable; create `users/` there if you use the inject plugin for multi-user context.

## 4. Enable channels and add users

- **Telegram**: Set bot token, start gateway, approve pairing or set allowlist. See [Adding users (Telegram + WhatsApp)](docs/ADDING-USERS.md).
- **WhatsApp**: Run `openclaw channels login`, add numbers to `allowFrom` or use pairing. See [Adding users](docs/ADDING-USERS.md).
- **Per-user identity**: Add each user to `session.identityLinks` with their canonical id and `telegram:...` / `whatsapp:...` peer ids. See [Multi-user context](docs/MULTI-USER-CONTEXT.md).

## 5. Optional: push to GitHub

If you want a dedicated repo for this customer:

```bash
git remote set-url origin https://github.com/YOUR_ORG/firstlight-openclaw.git
git add .
git commit -m "Customize for FirstLight"
git push -u origin main
```

Keep secrets out of the repo; use env or a secrets manager in CI/deploy.
