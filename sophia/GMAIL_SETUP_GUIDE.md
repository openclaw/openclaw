# Gmail Setup Guide for OpenClaw (Sophia)

This guide walks you through connecting your Gmail account to OpenClaw so that
incoming emails trigger Sophia as an agent. It is written for people who are not
familiar with Google Cloud or command-line tools. Follow every step in order.

---

## Overview of What We Are Building

```
Gmail inbox
    │  (new email arrives)
    ▼
Google Cloud Pub/Sub
    │  (pushes a notification)
    ▼
Your machine running OpenClaw (via a public HTTPS URL from Tailscale)
    │  (receives the webhook)
    ▼
Sophia agent runs and processes the email
```

Gmail does **not** send emails directly to OpenClaw. Instead it sends a tiny
notification to Google Cloud Pub/Sub, which then pushes that notification to a
public HTTPS URL on your machine. That is why you need a Google Cloud project
and Tailscale.

---

## What You Will Need

- A **Mac** or **Linux** machine that runs OpenClaw continuously (a Raspberry Pi,
  a home server, or your Mac). **This does not work on Render or any cloud
  shell.**
- A **Gmail account** (the one Sophia will monitor).
- A **Google account** that can create Google Cloud projects (can be the same
  Gmail account).
- **Tailscale** installed and connected on that machine (free plan is fine).
- **Homebrew** installed on macOS (`/bin/bash -c "$(curl -fsSL
  https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`).
  On Linux you will install tools manually — notes are included below.
- **OpenClaw** already installed and your gateway already running.

---

## Part 1 — Create a Google Cloud Project

1. Open https://console.cloud.google.com in your browser.
2. Sign in with any Google account (it does not have to be the Gmail account
   Sophia will monitor — it just needs to be able to create projects).
3. At the top of the page, click the project selector dropdown (it shows a
   project name or "Select a project").
4. Click **New Project**.
5. Give it any name, for example `openclaw-gmail`. Note the **Project ID** shown
   below the name field — you will need it later. Click **Create**.
6. Wait a few seconds for the project to be created, then make sure it is
   selected in the top dropdown.

---

## Part 2 — Enable the Required APIs

Still in Google Cloud Console, with your new project selected:

1. In the left sidebar go to **APIs & Services → Library**.
2. Search for **Gmail API**. Click it, then click **Enable**.
3. Go back to the library, search for **Cloud Pub/Sub API**. Click it, then
   click **Enable**.

---

## Part 3 — Create an OAuth 2.0 Client for `gog`

The `gog` tool (which OpenClaw uses internally to talk to Gmail) needs an OAuth
credentials file.

1. In the left sidebar go to **APIs & Services → Credentials**.
2. Click **+ Create Credentials → OAuth client ID**.
3. If prompted to configure the consent screen:
   - Click **Configure Consent Screen**.
   - Choose **External**, click **Create**.
   - Fill in **App name** (any name, e.g. `openclaw`), your email for support,
     and your email for developer contact. Click **Save and Continue** through
     all steps, then **Back to Dashboard**.
   - Return to **Credentials → + Create Credentials → OAuth client ID**.
4. For **Application type** choose **Desktop app**.
5. Give it any name (e.g. `gogcli`). Click **Create**.
6. A dialog appears showing your client ID and secret. Click
   **Download JSON** (the download icon on the right).
7. Save that file — it is your `credentials.json`.

---

## Part 4 — Place the Credentials File

On the machine where OpenClaw runs, place the file you just downloaded:

**macOS:**
```bash
mkdir -p "$HOME/Library/Application Support/gogcli"
cp ~/Downloads/client_secret_*.json "$HOME/Library/Application Support/gogcli/credentials.json"
```

**Linux:**
```bash
mkdir -p ~/.config/gogcli
cp ~/Downloads/client_secret_*.json ~/.config/gogcli/credentials.json
```

The file must be named exactly `credentials.json` in that folder.

---

## Part 5 — Install Required Tools

### macOS (automatic via Homebrew)

The setup command installs `gcloud`, `gog`, and `tailscale` automatically via
Homebrew if they are missing. You can skip to Part 6. But if you want to install
them manually first:

```bash
brew install --cask google-cloud-sdk
brew install gogcli
brew install tailscale
```

### Linux (manual)

**Install `gcloud`:**
```bash
# Debian / Ubuntu
sudo apt-get install -y apt-transport-https ca-certificates gnupg
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] \
  https://packages.cloud.google.com/apt cloud-sdk main" \
  | sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list
curl https://packages.cloud.google.com/apt/doc/apt-key.gpg \
  | sudo apt-key --keyring /usr/share/keyrings/cloud.google.gpg add -
sudo apt-get update && sudo apt-get install -y google-cloud-cli
```

**Install `gog` (gogcli):**
Check https://github.com/google/go-gcloud for the latest release, or:
```bash
# Replace X.Y.Z with the latest version
curl -Lo /usr/local/bin/gog \
  https://github.com/google/go-gcloud/releases/latest/download/gog-linux-amd64
chmod +x /usr/local/bin/gog
```

**Install Tailscale:**
```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

---

## Part 6 — Connect Tailscale

Tailscale provides the public HTTPS URL that Google Pub/Sub will push
notifications to.

1. If you do not have a Tailscale account, create one at https://tailscale.com
   (free).
2. On your machine run:
   ```bash
   tailscale up
   ```
   Follow the link it prints to log in.
3. Enable **Tailscale Funnel** for your machine in the Tailscale admin panel
   (https://login.tailscale.com/admin/machines → click your machine →
   **Enable Funnel**). Funnel is what allows Google to reach your machine over
   the internet.
4. Verify Tailscale is running:
   ```bash
   tailscale status
   ```
   You should see your machine listed with a DNS name like
   `your-machine.tail1234.ts.net`.

---

## Part 7 — Authenticate `gcloud`

On the machine where OpenClaw runs:

```bash
gcloud auth login
```

A browser window opens. Sign in with the **same Google account** you used to
create the GCP project. After signing in the terminal will say authentication
was successful.

---

## Part 8 — Run the Gmail Setup Command

Now run the one command that does everything else automatically:

```bash
openclaw webhooks gmail setup --account your@gmail.com
```

Replace `your@gmail.com` with the Gmail address Sophia should monitor.

**Optional flags:**
- `--project your-project-id` — only needed if the GCP project ID could not be
  detected automatically from your credentials file.
- `--label INBOX` — which Gmail label to watch (default is `INBOX`).
- `--tailscale funnel` — how to expose the endpoint (default is `funnel`; other
  options: `serve`, `off`).

**What the command does automatically:**
1. Checks that `gcloud`, `gog`, and `tailscale` are installed.
2. Verifies `gcloud` is authenticated (runs `gcloud auth login` if not).
3. Enables Gmail API and Pub/Sub API in your GCP project.
4. Creates a Pub/Sub topic named `gog-gmail-watch`.
5. Grants Gmail's service account permission to publish to that topic.
6. Creates a Pub/Sub push subscription pointing to your Tailscale funnel URL.
7. Registers a Gmail watch on your inbox using `gog`.
8. Writes the full configuration to `~/.openclaw/config.yml`.

**Expected output (success):**
```
Gmail hooks configured:
- project: openclaw-gmail
- topic: projects/openclaw-gmail/topics/gog-gmail-watch
- subscription: gog-gmail-watch-push
- push endpoint: https://your-machine.tail1234.ts.net/gmail-pubsub?token=abc123
- hook url: http://127.0.0.1:18789/hooks/gmail
- config: ~/.openclaw/config.yml
Next: openclaw webhooks gmail run
```

---

## Part 9 — Start the Gmail Watcher

The setup command registers the watch with Google but does not keep it running.
You need to also start the watcher process:

```bash
openclaw webhooks gmail run
```

This process must stay running (or be run in the background) for Sophia to
receive emails. On a server you can run it in a `tmux` or `screen` session:

```bash
tmux new-session -d -s gmail-watcher 'openclaw webhooks gmail run'
```

> **Note:** The OpenClaw gateway also auto-starts the watcher when it boots, so
> if your gateway is already running you may not need to run this separately.
> Check with: `tail -n 50 /tmp/openclaw-gateway.log | grep gmail`

---

## Part 10 — Verify It Works

Send a test email to the Gmail address Sophia is monitoring. Within a few
seconds you should see Sophia respond or log activity.

**Check the gateway log:**
```bash
tail -n 100 /tmp/openclaw-gateway.log | grep -i gmail
```

**Check hooks are enabled:**
```bash
openclaw hooks list
```

You should see a `gmail` preset listed.

---

## Troubleshooting

### "GCP project id required"
The setup command could not read the project from your credentials file.
Add `--project your-project-id` to the command (use the Project ID from step 5
of Part 1, not the project name).

### "gcloud not installed" on Linux
Follow the Linux install steps in Part 5.

### "tailscale DNS name missing; run tailscale up"
Run `tailscale up` and make sure Funnel is enabled in the Tailscale admin panel.

### "gog watch start failed"
Usually means the `credentials.json` is in the wrong place or is the wrong
file. Double-check Part 4. Also verify that the Gmail API is enabled in your
GCP project (Part 2).

### Pub/Sub push endpoint not receiving anything
- Make sure Tailscale Funnel is enabled for your machine.
- Run `tailscale funnel status` to check active funnels.
- Check that the push subscription endpoint in GCP Console matches your current
  Tailscale URL (it can change if you re-install Tailscale).

### Watch expires after 7 days
Gmail watch subscriptions expire after 7 days maximum. OpenClaw renews
automatically every 12 hours by default. If the watcher process was stopped for
more than 7 days, re-run:
```bash
openclaw webhooks gmail setup --account your@gmail.com
openclaw webhooks gmail run
```

---

## Summary of Commands (Quick Reference)

```bash
# One-time setup (run once)
openclaw webhooks gmail setup --account your@gmail.com

# Start the watcher (keep this running)
openclaw webhooks gmail run

# Or start it in the background with tmux
tmux new-session -d -s gmail-watcher 'openclaw webhooks gmail run'

# Check hooks are active
openclaw hooks list

# Check gateway logs for gmail activity
tail -f /tmp/openclaw-gateway.log | grep -i gmail
```
