---
summary: "Run OpenClaw Gateway on a boxd VM with a systemd service and the VM's HTTPS URL"
read_when:
  - Running OpenClaw on boxd
  - You want an always-on Linux VM for the Gateway with an HTTPS URL
title: "boxd"
---

Run a persistent OpenClaw Gateway on a [boxd](https://boxd.sh)
VM. A boxd VM is a full Ubuntu machine with a persistent disk, systemd, and an
HTTPS URL that forwards to port 8000 on the VM.

The Gateway stays on loopback. nginx on port 8000 forwards the VM's HTTPS URL
to it, the same pattern as the [exe.dev](/install/exe-dev) guide.

## What you need

- boxd account
- boxd CLI on your local machine (`curl -fsSL https://boxd.sh/downloads/install.sh | sh`), signed in with `boxd auth login`
- API key for your model provider (Anthropic, OpenAI, etc.)

## Create the VM

From your local machine:

```bash
boxd machine new openclaw --isolated --auto-hibernate-timeout=0
```

| Flag                         | Why                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `--isolated`                 | Keeps boxd credentials and your other VMs out of reach of the agent's shell and file tools |
| `--auto-hibernate-timeout=0` | Keeps the VM awake when idle, so channels, heartbeats, and cron run                        |

An isolated VM has no boxd CLI, integration tokens, or git credentials inside
it, and does not join the private network your other boxd VMs share. It keeps
its HTTPS URL and outbound internet access.

The output includes the VM's `url`, for example `openclaw.nyc.boxd.sh`. The
host depends on your region. This guide writes it as `<vm-host>`.

<Tip>
State lives on the VM's persistent disk: `openclaw.json`, auth stores,
sessions, and channel state under `~/.openclaw/`, plus the workspace under
`~/.openclaw/workspace/`.
</Tip>

## Connect

```bash
boxd connect openclaw
```

Run the remaining commands in this shell on the VM, unless a step says
otherwise.

## Install OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
```

The VM already has a supported Node 24 release, so the installer uses it.

## Run onboarding

```bash
openclaw onboard --non-interactive --accept-risk \
  --anthropic-api-key YOUR_ANTHROPIC_KEY \
  --install-daemon \
  --skip-channels --skip-skills --skip-hooks --skip-search
```

`--install-daemon` installs the Gateway as a systemd user service. boxd VMs
enable lingering for the `boxd` user, so the service starts at boot without a
login. Swap the key flag for your provider (`--openai-api-key`,
`--openrouter-api-key`, and so on); `openclaw onboard --help` lists them all.

Check the service:

```bash
openclaw gateway status
```

Look for `Runtime: running` and `Listening: 127.0.0.1:18789`. The status also
notes that the service uses Node from a version manager (see
[Updating](#updating)) and that a host shutdown limits the Gateway drain to 5s.
Both are expected here and do not stop the Gateway from running.

## Put nginx in front of the Gateway

nginx is installed on boxd VMs but disabled. Point it at the Gateway:

```bash
sudo tee /etc/nginx/sites-available/default > /dev/null <<'EOF'
server {
    listen 8000;
    listen [::]:8000;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Overwrite forwarding headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;

        # Long-lived connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
EOF
sudo nginx -t
sudo systemctl enable --now nginx
```

boxd terminates TLS before port 8000, so nginx sets `X-Forwarded-Proto` to
`https`. It overwrites `X-Forwarded-For` instead of appending to it; see the
[exe.dev](/install/exe-dev) guide for why. As a result, the Gateway sees every
browser as coming from boxd's proxy address, not the client's own IP.

## Allow the browser origin

Allow the VM's HTTPS origin and trust only the loopback nginx hop:

```bash
openclaw config set gateway.controlUi.allowedOrigins '["https://<vm-host>"]' --strict-json
openclaw config set gateway.trustedProxies '["127.0.0.1"]' --strict-json
openclaw gateway restart
```

Use scheme and host only, with no trailing slash. The Gateway compares the
browser origin literally.

## Open the dashboard

Print the gateway token in the VM shell:

```bash
openclaw gateway auth-token --show
```

The command only prints the token in an interactive terminal, such as the
`boxd connect` shell.

Open `https://<vm-host>/` in your browser and paste the token when the
Control UI asks for it.

### Approve your device

The first browser connection queues a device pairing request, and the Control
UI shows the `openclaw devices approve` command with its request id. In the VM
shell:

```bash
openclaw devices list
openclaw devices approve REQUEST_ID
```

The Control UI connects once the request is approved.

## Security

The VM's HTTPS URL is public, and nothing authenticates requests in front of
it. Anyone who knows the URL can load the Control UI. Access to the Gateway is
protected in two layers:

| Layer           | Description                                            |
| --------------- | ------------------------------------------------------ |
| Gateway token   | Required to connect via the Control UI                 |
| Device approval | Each new browser or client must be explicitly approved |

The Gateway itself stays bound to loopback. Keep the gateway token private.
If you do not want the Control UI on a public URL, skip the nginx step and use
one of the private paths in [Gateway remote access](/gateway/remote) instead.
See [Gateway security](/gateway/security).

## Channel setup

Run channel setup from the VM shell, as on any Linux host. Telegram and
WhatsApp connect outbound, so they need no inbound URL. See
[Channels](/channels) and [Pairing](/channels/pairing).

## Hibernate and wake

To pause the VM when you do not need the assistant, hibernate it from your
local machine:

```bash
boxd machine hibernate openclaw
```

Hibernating saves memory and disk. Channels, heartbeats, and cron do not run
while the VM is hibernated. Wake it with:

```bash
boxd machine wake openclaw
```

The Gateway process resumes where it stopped, and an open Control UI tab
reconnects on its own.

After a reboot (`boxd machine reboot openclaw`), the systemd service starts the
Gateway again.

## Updating

See [Updating](/install/updating). The installer puts OpenClaw in the `boxd`
user's own npm prefix, so updates need no `sudo`.

`openclaw gateway status` notes that the service uses Node from a version
manager. On boxd that is the VM's default Node. If you switch Node versions,
reinstall the service with `openclaw gateway install --force`.

## Troubleshooting

### `origin not allowed`

`gateway.controlUi.allowedOrigins` must match `https://<vm-host>` exactly.
Check the host with `boxd machine get openclaw` on your local machine.

### Dashboard shows a boxd page instead of OpenClaw

boxd shows its own page when nothing answers on port 8000. Check that nginx
and the Gateway are running:

```bash
systemctl is-active nginx
openclaw gateway status
```

### Non-browser clients get a boxd check page

Depending on the VM's bot-protection mode, boxd asks visitors to pass a
browser check first: on every request in mode `on`, and only while the VM is
hibernated in mode `sleep_only`. Check the mode from your local machine:

```bash
boxd machine config get openclaw bot-protection
```

If a webhook or API client needs to reach the Gateway, turn it off:

```bash
boxd machine config set openclaw bot-protection off
```

## Related

- [exe.dev](/install/exe-dev)
- [Gateway remote access](/gateway/remote)
- [Gateway security](/gateway/security)
- [Updating OpenClaw](/install/updating)
