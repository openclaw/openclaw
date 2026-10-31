---
summary: "Host OpenClaw on a Prized box, a cloud VM managed with the prized CLI, with SSH tunnel access"
read_when:
  - Deploying OpenClaw to Prized
  - You want an always-on cloud Linux VM for the Gateway without running your own VPS
title: "Prized"
---

Run a persistent OpenClaw Gateway on a [Prized](https://prized.dev) box: an
Ubuntu 24.04 VM in the cloud that you reach, pause, and resume with the
`prized` CLI.

Prized maintains its own walkthrough at
[Run OpenClaw on a Prized box](https://prized.dev/docs/openclaw).

Keep the Gateway on loopback and use an SSH tunnel for the Control UI. Do not
expose the Gateway port to the public internet.

## Prerequisites

- Prized account
- API key for your model provider
- A **Micro** box (2 vCPU, 4 GB RAM) or larger. In testing the Gateway used
  about 1.5 GB of memory, so a Nano (2 GB) is tight. A Micro awake around the
  clock costs about $25 a month ([Prized billing](https://prized.dev/docs/billing)).

## Create a box

Sign up at [prized.dev](https://prized.dev) and follow the tour. Pick
**Micro** when it asks for a size. The command the tour shows installs the
`prized` CLI, signs it in, and connects the box, including an SSH alias with
the box's name. Use that name in place of `<box>` on this page.

If your box is a Nano, resize it. It restarts with its files:

```bash
prized box resize <box> micro
```

Switch off auto-pause for the box. On free credit a box pauses after 2 hours
idle, and a Gateway waiting for messages looks idle:

```bash
prized box auto-pause <box> off
```

## Install OpenClaw

Open a shell on the box:

```bash
prized ssh <box>
```

On the box, install OpenClaw without onboarding:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
```

The installer adds Node.js 24 and puts `openclaw` in `~/.npm-global/bin`. Start
a new login shell so it is on your `PATH`:

```bash
exec bash -l
openclaw --version
```

## Run onboarding

```bash
openclaw onboard --install-daemon
```

Onboarding sets up model auth, channels, and the Gateway token, and installs the
Gateway as a systemd user service. It ends in a terminal chat with your agent.
Press Ctrl+C twice to leave the chat; the Gateway keeps running. Prized boxes
keep user services running after you log out and start them again when the box
boots.

Check the Gateway:

```bash
openclaw gateway status
```

## Open the Control UI

From your machine, forward the Gateway port through the box's SSH alias:

```bash
ssh -N -L 18789:127.0.0.1:18789 <box>
```

Open `http://localhost:18789`. In your `prized ssh` session, run
`openclaw gateway auth-token --show` and paste the token into **Gateway
secret**. If the Control UI reports `pairing required`, approve the browser on
the box with `openclaw devices list` and `openclaw devices approve <requestId>`.

## Pause and resume

A paused Micro usually keeps its memory, so the same Gateway process continues
when the box wakes. If the box restarts instead, for example after a long sleep,
the service starts the Gateway at boot. While the box is paused, the assistant
cannot answer messages.

```bash
prized box pause <box>
prized box resume <box> --wait
```

After the box wakes, give the Gateway a minute or two before the first reply.

## Troubleshooting

### Gateway install reports unsafe-permissions

If `openclaw gateway install` reports `[unsafe-permissions]`, run `chmod go-w`
on the directory it names and run it again. A directory you create by hand on
the box, such as `~/.config/systemd/user`, is group writable under the default
`0002` umask.

### openclaw: command not found

The installer's `PATH` change applies to new login shells. Run `exec bash -l`
in your shell on the box.

### No replies after a while

Check that auto-pause is off for the box with `prized box ls`. The `AUTO-PAUSE`
column should read `off`. On free credit, boxes also pause when the credit runs
out.

## Next steps

- Set up messaging channels: [Channels](/channels)
- Configure the Gateway: [Gateway configuration](/gateway/configuration)
- Keep OpenClaw up to date: [Updating](/install/updating)
- Compare hosting options: [Linux server](/vps)

## Related

- [Remote access](/gateway/remote)
- [Gateway security](/gateway/security)
- [Updating OpenClaw](/install/updating)
