---
summary: "Running agent tools in Docker sandboxes, and fixing a gateway container that misbehaves"
read_when:
  - You want agent tool execution isolated in containers
  - The sandbox image or Control UI pairing is not working
title: "Docker agent sandbox and troubleshooting"
sidebarTitle: "Sandbox and troubleshooting"
---

Enabling the Docker agent sandbox, and fixes for sandbox images, permissions, and Control UI pairing. Part of the [Docker](/install/docker) guide.

## Agent sandbox

When `agents.defaults.sandbox` is enabled with the Docker backend, the gateway runs agent tool execution (shell, file read/write, etc.) inside isolated Docker containers while the gateway itself stays on the host — a hard wall around untrusted or multi-tenant agent sessions without containerizing the whole gateway.

Sandbox scope can be per-agent (default), per-session, or shared; each scope gets its own workspace mounted at `/workspace`. You can also configure allow/deny tool policies, network isolation, resource limits, and browser containers.

For full configuration, images, security notes, and multi-agent profiles:

- [Sandboxing](/gateway/sandboxing) -- complete sandbox reference
- [OpenShell](/gateway/openshell) -- OpenShell-managed local or remote sandbox backend
- [Multi-agent sandbox and tools](/tools/multi-agent-sandbox-tools) -- per-agent overrides

### Quick enable

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared
      },
    },
  },
}
```

Build the missing configured OpenClaw Docker sandbox image:

```bash
openclaw doctor
```

From a source checkout, you can also run `scripts/sandbox-setup.sh` directly. See [Sandboxing § Images and setup](/gateway/sandboxing#images-and-setup) for custom/Podman images and the older-release fallback.

## Troubleshooting

<AccordionGroup>
  <Accordion title="Image missing or sandbox container not starting">
    Run `openclaw doctor` to build a missing configured OpenClaw default/common or default Docker browser image. For a custom or Podman image, build or pull it yourself and set `agents.defaults.sandbox.docker.image`. See [Sandboxing § Images and setup](/gateway/sandboxing#images-and-setup) for direct source-checkout commands and the older-release fallback. Containers are auto-created per session on demand.
  </Accordion>

  <Accordion title="Permission errors in sandbox">
    Set `docker.user` to a UID:GID that matches your mounted workspace ownership, or chown the workspace folder.
  </Accordion>

  <Accordion title="Custom tools not found in sandbox">
    OpenClaw runs commands with `sh -lc` (login shell), which sources `/etc/profile` and may reset PATH. Set `docker.env.PATH` to prepend your custom tool paths, or add a script under `/etc/profile.d/` in your Dockerfile.
  </Accordion>

  <Accordion title="OOM-killed during image build (exit 137)">
    A local source image build needs at least 6 GB RAM. Use a larger machine class or a pre-built image and retry.
  </Accordion>

  <Accordion title="Unauthorized or pairing required in Control UI">
    Fetch a fresh dashboard link and approve the browser device:

    ```bash
    docker compose run --rm openclaw-cli dashboard --no-open
    docker compose run --rm openclaw-cli devices list
    docker compose run --rm openclaw-cli devices approve <requestId>
    ```

    More detail: [Dashboard](/web/dashboard), [Devices](/cli/devices).

  </Accordion>

  <Accordion title="Gateway target shows ws://172.x.x.x or pairing errors from Docker CLI">
    Reset gateway mode and bind:

    ```bash
    docker compose run --rm openclaw-cli config set --batch-json '[{"path":"gateway.mode","value":"local"},{"path":"gateway.bind","value":"lan"}]'
    docker compose run --rm openclaw-cli devices list --url ws://127.0.0.1:18789
    ```

  </Accordion>
</AccordionGroup>
