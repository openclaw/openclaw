---
summary: "Run OpenClaw in a Docker Sandbox with proxy-managed credentials and sandboxed tool calls"
read_when:
  - You want to run OpenClaw somewhere isolated without managing a VPS
  - You want the provider credential stored outside the sandbox the agent runs in
  - You want the Gateway itself isolated from your host, not only tool execution
title: "Docker Sandboxes"
---

Run OpenClaw in a [Docker Sandbox](https://docs.docker.com/ai/sandboxes/): a
microVM on your own machine, with its own kernel and its own Docker engine. The
credential you store never has to be written inside it, because the sandbox
receives a placeholder value and the sandbox proxy substitutes the real one on
requests leaving for the provider host. The agent's own tool calls then run in a
second sandbox nested inside the first.

How far that substitution isolates the credential from code running in the
sandbox is a property of Docker Sandboxes and the kit, not of OpenClaw. Treat it
as the placeholder-substitution mechanism described above rather than a
guarantee this page can make.

This page covers local sandboxes. Cloud sandboxes (`sbx --cloud`) cannot mount a
host workspace and are deleted when their expiration lapses, so they do not suit
a Gateway you mean to keep running.

The environment ships as a kit, so this is two commands: store a credential,
then start.

<Note>
The `openclaw` kit is community maintained in
[docker/sbx-kits-contrib](https://github.com/docker/sbx-kits-contrib/tree/main/openclaw).
Report kit issues and contribute there. That repository owns the kit's own
behavior and reference; this page covers only the OpenClaw side of the setup.
</Note>

## How this fits with OpenClaw's own isolation

OpenClaw has its own sandboxing, and this page is a different layer. They
compose rather than duplicate:

- Docker Sandboxes isolates your **host** from everything OpenClaw runs, the
  Gateway included, and enforces network policy outside the VM.
- OpenClaw [sandboxing](/gateway/sandboxing), which this kit turns on, isolates
  **Gateway state** from agent tool execution. Config, the Gateway token,
  channel credentials, and the session store stay outside the container the
  agent's shell runs in.
- The OpenClaw [secret egress proxy](/gateway/secrets#secret-egress-proxy) is a
  third, unrelated mechanism, and this setup does not use it. It covers
  Gateway-hosted exec rather than sandboxed tool calls, and here the provider
  credential is handled by the sandbox proxy instead.

So nothing extra has to be enabled in OpenClaw to get the credential handling
described below.

## What you need

- The `sbx` CLI. It ships its own `sandboxd` daemon and does not need Docker
  Desktop. See the [Docker Sandboxes docs](https://docs.docker.com/ai/sandboxes/)
  for install steps.
- A Docker login, so kit and template images can be pulled: `sbx login`.
- An Anthropic API key, or a token from `claude setup-token` on a machine with
  Claude Code.

## Store the credential first

Credentials are wired when a sandbox is created, so store yours before starting
one. Both commands prompt with `Enter secret:` and read the value from stdin, so
it never becomes a shell argument.

An API key goes in as a service secret:

```bash
sbx secret set anthropic
```

A Claude subscription token goes in as a custom secret, with a placeholder
shaped like an OAuth token:

```bash
sbx secret set-custom \
  --host api.anthropic.com \
  --env ANTHROPIC_OAUTH_TOKEN \
  --placeholder 'sk-ant-oat01-{rand}'
```

Bind one credential, not both. The two are not interchangeable on the wire:
OpenClaw picks the request shape from the token it holds, and Anthropic rejects
the wrong shape or two auth headers at once. The kit's
[How auth works](https://github.com/docker/sbx-kits-contrib/blob/main/openclaw/README.md#how-auth-works)
owns which host credential produces which wire format, and how to switch
between them.

<Warning>
Do not authenticate from inside the sandbox. OpenClaw's own auth commands write
a real credential to the agent's auth store in the container, where the agent
and anything it runs can read it, which defeats the whole proxy-managed model.
</Warning>

## Network policy

The kit declares the hosts it needs, and those rules are added to your host's
policy rather than replacing it. Denies win over allows, and the shipped presets
include broad wildcards, so "only the kit's hosts are reachable" describes a host
with a strict policy rather than the kit on its own. Check where yours stands:

```bash
sbx policy ls
```

Prefer a deny-all posture for this kit. Its own end-to-end tests run that way,
so the declared list is known sufficient there, and anything the kit does not
declare stays unreachable even when a credential names it.

## Start OpenClaw

```bash
sbx run --kit "docker.io/sbx/openclaw-kit:latest" openclaw
```

This lands you in `openclaw chat`. Say hello: a reply means the Gateway, its
token, and your provider credential are all wired correctly.

The kit has already done the parts that are easy to get wrong. The Gateway
starts with the container rather than on attach, so its published port answers
before anyone attaches. It generates its own token on first boot, because it
binds to the container's external interface for port publishing and OpenClaw
refuses a non-loopback bind without one. And it enables
[Docker-backed sandboxing](/gateway/sandboxing#docker-backend) for tool
execution, pulling the image it needs on first boot, so the agent's shell never
shares a filesystem with the Gateway's credential state:

```bash
sbx exec <sandbox-name> -- openclaw sandbox list
```

Tool calls land in a container named `openclaw-sbx-<session>` as an unprivileged
user, with the agent workspace at `/workspace`. That inner Docker daemon is the
sandbox's own, separate from the one on your machine, so the
[Docker-out-of-Docker constraints](/gateway/sandboxing#docker-backend) do not
apply.

## Open the Control UI

Pin the host port to the Gateway's own port rather than taking the ephemeral one
the runtime assigns:

```bash
sbx ports <sandbox-name> --publish 18789:18789/tcp
```

Then open `http://127.0.0.1:18789/`. Both halves of that address matter. On a
non-loopback bind the Gateway seeds its Control UI origin allowlist with its own
port and nothing else, and a port-forwarded browser connection does not count as
a local client, so a browser arriving on any other port is refused with
`origin not allowed`. Use the loopback address rather than a LAN one, because
the Control UI needs a secure context to present a device identity.

Paste the Gateway token when asked. Read it from the config file, since
`openclaw config get gateway.auth.token` returns a redaction placeholder rather
than the value:

```bash
sbx exec <sandbox-name> -- sh -lc 'jq -r .gateway.auth.token ~/.openclaw/openclaw.json'
```

Wait for `~/.openclaw/gateway-ready` before reading it. Earlier, the key is
absent and `jq -r` prints `null`.

## Drive it from scripts

`sbx exec` reaches the same Gateway without attaching:

```bash
sbx exec <sandbox-name> -- openclaw agent --agent main --message "what version are you running"
```

Wait for `~/.openclaw/gateway-ready` first if you run this right after starting a
sandbox. Startup commands do not block `sbx exec`, and that sentinel is what the
kit writes once the Gateway is serving.

## Change the credential or the kit

Both are applied at create time, so neither takes effect in a running sandbox.
Store the new secret or pull the new kit, then start a fresh one:

```bash
sbx rm -f <sandbox-name>
sbx run --kit "docker.io/sbx/openclaw-kit:latest" openclaw
```

Recreating discards everything living inside the sandbox, including the Gateway
token minted on first boot and any channels configured from within the session.

`:latest` follows the kit's `main`. Every kit build also publishes an immutable
`<date>-<sha>` tag, so pass one of those instead to hold a sandbox on a known
kit revision. That pins kit content rather than the whole environment, because
the image the kit boots stays on a floating tag by design. See
[Pinning a kit revision](https://github.com/docker/sbx-kits-contrib/blob/main/openclaw/README.md#pinning-a-kit-revision).

<Warning>
The OpenClaw version comes from the kit's image, not from an in-place update.
`openclaw update` inside the sandbox can fail when the image's Node is older
than the engine floor of the release it tries to install, so treat a newer
OpenClaw as a kit bump and recreate from a newer kit. Check what a sandbox has
with `sbx exec <sandbox-name> -- openclaw --version`.
</Warning>

## Troubleshooting

| Symptom                                                                                   | Cause                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `No API key found for provider "anthropic"`                                               | No credential bound on the host. Store one, then start a fresh sandbox.                                                                                           |
| `authentication_error: API key is invalid`                                                | The credential reached Anthropic in the wrong shape, usually a subscription token bound as a service secret, or a stale service secret still setting `x-api-key`. |
| `authentication_error: OAuth access token is invalid`                                     | The bearer placeholder went out unswapped, so no matching credential is bound for that host.                                                                      |
| `auth flow failed (exit 1)` after `/auth`                                                 | Interactive login needs a TTY the TUI's subprocess does not get. Credentials belong on the host.                                                                  |
| `origin not allowed` in the browser                                                       | The Control UI was opened on a host port other than the Gateway's. Republish with `--publish 18789:18789/tcp` and open `http://127.0.0.1:18789/`.                 |
| `control ui requires device identity`                                                     | The Control UI needs a secure context. Open it on `127.0.0.1` rather than a LAN address.                                                                          |
| `jq -r` prints `null` for the token                                                       | The Gateway has not finished its first boot. Wait for `~/.openclaw/gateway-ready`.                                                                                |
| `Sandbox image not found: docker/sandbox-templates:shell-docker. Build or pull it first.` | The kit's first-boot image pull has not finished. Check `~/.openclaw/sandbox-image-pull.log` in the sandbox.                                                      |
| A new secret changes nothing                                                              | Credentials are wired at create time. Start a fresh sandbox.                                                                                                      |

## Related

- [Channels](/channels) -- connect Telegram, Discord, WhatsApp, or Slack
- [Gateway configuration](/gateway/configuration)
- [Sandboxing](/gateway/sandboxing) -- the tool-execution sandbox the kit turns on
- [Secret egress proxy](/gateway/secrets#secret-egress-proxy) -- the unrelated OpenClaw mechanism this setup does not use
- [Security](/gateway/security)
