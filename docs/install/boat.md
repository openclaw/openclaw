---
summary: "Run the OpenClaw Gateway on Boat, or select Boat for Crabbox cloud workers"
read_when:
  - You want to run OpenClaw on a Boat Ubuntu sandbox
  - You want a Boat cloud worker while keeping the Gateway elsewhere
title: "Boat"
---

[Boat](https://boat.dev), formerly ASCII Box, provides Ubuntu virtual machines
with SSH and Docker. There are two different ways to use it with OpenClaw:

- **Host the Gateway on Boat**: the Gateway, channels, credentials, and workspace
  live on the VM. Follow the hosting steps below.
- **Keep your Gateway elsewhere and run cloud sessions on Boat**: use the existing
  [Crabbox cloud worker provider](#cloud-workers-through-crabbox). Do not install
  another OpenClaw sandbox provider plugin.

Boat owns VM allocation, billing, stop/resume, and snapshots. OpenClaw is not a
Boat model provider and does not route inference through Boat's integrated agents.

## Host the Gateway on Boat

### Create and connect

Install the Boat CLI using its [official quickstart](https://docs.boat.dev/quickstart),
sign in with `boat login`, and create a sandbox from your local terminal:

```bash
boat new --type default --no-env --no-auto-stop
```

Copy the returned sandbox ID and use it explicitly in later commands. The
examples below use `bx_23456789`; replace it with your own ID.

- `--no-env` avoids injecting Boat account environments and credentials into the
  new VM. Configure your OpenClaw connections during onboarding instead.
- `--no-auto-stop` is for an always-on Gateway and requires an eligible Boat plan.
  It keeps compute billing active until you stop the sandbox. For a bounded test,
  omit it and check the auto-stop deadline with `boat info`; the default is one hour.
  OpenClaw activity does not automatically extend Boat's deadline.

```bash
boat ssh bx_23456789
```

### Install and onboard

Inside the Boat SSH shell, use the standard OpenClaw installer and onboarding:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
openclaw onboard --install-daemon
openclaw gateway status
```

For an existing installation, use `openclaw configure` to change connections
instead of repeating onboarding. The installer checks the Node runtime;
Boat's preinstalled Node is not a guarantee that it meets OpenClaw's current
[requirements](/install/node).

Keep the Gateway bound to loopback. If a user service cannot be installed in
your SSH environment, run `openclaw gateway run` in the foreground for testing,
or follow [Linux service setup](/platforms/linux). A foreground process ends when
its terminal closes and does not restart after a Boat stop/resume.

### Open the dashboard privately

From a second terminal on your own computer, forward the Gateway port:

```bash
boat forward bx_23456789 --remote 18789 --local 18789
```

Keep the forward running and open `http://127.0.0.1:18789/`. If you changed the
Gateway port, change `--remote` too; use another `--local` port if necessary.
For token authentication, run this in an interactive SSH terminal on the VM
and paste the token into the Control UI when prompted:

```bash
openclaw gateway auth-token --show
```

The forward is private and does not require `boat host`, a public preview URL,
relaxed origin checks, or disabled device authentication. Treat Gateway tokens
and any Boat access URLs as secrets. See [remote access](/gateway/remote).

### Stop, resume, and backups

Run these from your local terminal:

```bash
boat stop bx_23456789
boat resume bx_23456789
boat info bx_23456789
boat ssh bx_23456789
```

Stopping ends running processes. Boat restores the saved disk on resume, but
that is not an always-running Gateway or a separate backup. Recheck the auto-stop
deadline after resume, verify `openclaw gateway status`, and restart your service
or foreground Gateway if needed. Restart the port forward too. Boat can assign
a new IP address and SSH host key; `boat ssh` refreshes its own connection data.

Back up your OpenClaw state and workspace independently before deleting a VM or
relying on a stopped snapshot long term. Boat's stopped-disk retention is bounded;
see [Boat snapshots](https://docs.boat.dev/snapshots) and
[OpenClaw migration and backups](/install/migrating).

## Cloud workers through Crabbox

For a Gateway running elsewhere, Boat uses the bundled `crabbox` worker provider,
not a new Boat plugin. Crabbox accepts `boat` as a provider selector while its
canonical catalog and durable lease identity remain `ascii-box`. OpenClaw resolves
the aliases advertised by Crabbox for OS and machine discovery; it does not
maintain a second vendor catalog.

Configure the supported Crabbox CLI and Boat credentials for the OS user running
the Gateway. Follow the [Crabbox Boat guide](https://github.com/openclaw/crabbox/blob/main/docs/providers/ascii-box.md):
the adapter retains legacy `ASCII_BOX_API_KEY` / `CRABBOX_ASCII_BOX_API_KEY`,
`asciiBox` configuration, and endpoint names. A standalone `boat login` or
`BOAT_API_KEY` alone is not the documented Crabbox authentication contract.
Keep these credentials out of OpenClaw profile settings and setup commands.

Merge this profile into your existing configuration:

```json5
{
  cloudWorkers: {
    profiles: {
      boat: {
        provider: "crabbox",
        install: "bundle",
        suspendAfter: "30m",
        readyWorkers: 0,
        settings: {
          provider: "boat",
          target: "linux",
          ttl: "2h",
          idleTimeout: "30m",
          warmImage: false,
        },
      },
    },
  },
}
```

This starts cold, without prepared reserves or automatic snapshot capture. Size
selection is left to Crabbox. Add `settings.class` only after checking your
installed Crabbox's Boat sizing contract; when its catalog is unmapped, OpenClaw
does not invent CPU/RAM values or machine choices. Boat's own desktop and saved
snapshots do not imply support for OpenClaw's `settings.desktop` or warm images.

Cloud workers need a Gateway reachable over public TLS and the normal node
pairing and execution approvals. Validate the profile, then follow the
[cloud worker verification flow](/gateway/cloud-workers/verify-the-profile) to
prove allocation, enrollment, a real agent turn, workspace reconciliation, and
teardown with your account. A catalog lookup is not a live allocation test.
Crabbox retains the lease and cleanup responsibility across interrupted dispatch;
keep its state and original account/endpoint available for recovery.

### Tool sandbox limitation

A cloud worker profile is different from `agents.defaults.sandbox.backend`.
Do not select Boat for the Crabbox tool sandbox unless
`crabbox exec --check --provider boat` reports both `execution: true` and
`currentRepoStop: true`. The Boat adapter checked for this guide reports both
as false; fixed lease IDs and SSH support alone are insufficient. Use the
[SSH backend](/gateway/sandboxing/ssh-backend) for an operator-managed running VM,
or a provider advertising the required [Crabbox sandbox capabilities](/gateway/sandboxing/crabbox-backend).

## Official Boat references

- [Quickstart](https://docs.boat.dev/quickstart)
- [SSH and private port forwarding](https://docs.boat.dev/ssh-access)
- [API overview](https://docs.boat.dev/api/v1)
- [Auto-stop](https://docs.boat.dev/long-running-tasks/auto-stop)
- [Snapshots and retention](https://docs.boat.dev/snapshots)
