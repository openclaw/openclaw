---
summary: "Every environment variable the Docker setup script and Compose file accept"
read_when:
  - You are tuning the Docker build or the gateway container
  - You need the OTLP or sandbox variable names
title: "Docker environment variables"
sidebarTitle: "Environment variables"
---

Optional variables for `scripts/docker/setup.sh` and the gateway container, plus build memory tuning. Part of the [Docker](/install/docker) guide.

## Environment variables

Optional variables accepted by `scripts/docker/setup.sh` (and, for the gateway container, by `docker-compose.yml` directly):

| Variable                                        | Purpose                                                                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_IMAGE`                                | Use a remote image instead of building locally                                                                                      |
| `OPENCLAW_GATEWAY_PORT`                         | Host-published gateway port (default `18789`); both containers keep port `18789` internally                                         |
| `OPENCLAW_IMAGE_APT_PACKAGES`                   | Install extra apt packages during build (space-separated). Legacy alias: `OPENCLAW_DOCKER_APT_PACKAGES`                             |
| `OPENCLAW_IMAGE_PIP_PACKAGES`                   | Install extra Python packages during build (space-separated)                                                                        |
| `OPENCLAW_EXTENSIONS`                           | Compile/package supported selected plugins and install their runtime dependencies (comma- or space-separated ids)                   |
| `OPENCLAW_DOCKER_BUILD_NODE_OPTIONS`            | Override the local source-build Node options (default `--max-old-space-size=8192`)                                                  |
| `OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB` | Override the local source-build tsdown heap in MB                                                                                   |
| `OPENCLAW_DOCKER_BUILD_SKIP_DTS`                | Skip declaration output during runtime-only local image builds (default `1`)                                                        |
| `OPENCLAW_INSTALL_BROWSER`                      | Bake Chromium + Xvfb into the image at build time                                                                                   |
| `OPENCLAW_EXTRA_MOUNTS`                         | Extra host bind mounts (comma-separated `source:target[:opts]`)                                                                     |
| `OPENCLAW_HOME_VOLUME`                          | Persist `/home/node` in a named Docker volume                                                                                       |
| `OPENCLAW_TZ`                                   | Set the gateway and CLI container timezone to an IANA name (default `UTC`)                                                          |
| `OPENCLAW_SANDBOX`                              | Opt in to sandbox bootstrap (`1`, `true`, `yes`, `on`)                                                                              |
| `OPENCLAW_SKIP_ONBOARDING`                      | Skip the interactive onboarding step (`1`, `true`, `yes`, `on`)                                                                     |
| `OPENCLAW_DOCKER_SOCKET`                        | Override the Docker socket path                                                                                                     |
| `OPENCLAW_DISABLE_BONJOUR`                      | Force Bonjour/mDNS advertising on (`0`) or off (`1`); see [Bonjour / mDNS](/install/docker/networking-and-storage#bonjour-%2F-mdns) |
| `OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS`      | Disable bundled plugin source bind-mount overlays                                                                                   |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                   | Shared OTLP/HTTP collector endpoint for OpenTelemetry export                                                                        |
| `OTEL_EXPORTER_OTLP_*_ENDPOINT`                 | Signal-specific OTLP endpoints for traces, metrics, or logs                                                                         |
| `OTEL_EXPORTER_OTLP_PROTOCOL`                   | Shared OTLP protocol fallback. Only `http/protobuf` is supported                                                                    |
| `OTEL_EXPORTER_OTLP_*_PROTOCOL`                 | Signal-specific protocol fallback for traces, metrics, or logs; wins over the shared fallback                                       |
| `OTEL_SERVICE_NAME`                             | Service name used for OpenTelemetry resources                                                                                       |
| `OTEL_SEMCONV_STABILITY_OPT_IN`                 | Opt in to latest experimental GenAI semantic attributes                                                                             |
| `OPENCLAW_OTEL_PRELOADED`                       | Skip starting a second OpenTelemetry SDK when one is preloaded                                                                      |

After changing `.env` or Compose environment settings, run `docker compose up -d openclaw-gateway` to recreate the gateway with the new values. `docker compose restart` does not apply environment changes.

The official image ships no Homebrew. During onboarding, OpenClaw hides brew-only skill dependency installers in a Linux container without `brew`; provide those dependencies through a custom image or install manually. Use `OPENCLAW_IMAGE_APT_PACKAGES` for Debian-packaged dependencies and `OPENCLAW_IMAGE_PIP_PACKAGES` for Python dependencies (runs `python3 -m pip install --break-system-packages` at build time, so pin versions and use only indexes you trust).

If Docker reports `ResourceExhausted`, `cannot allocate memory`, or aborts during `tsdown`, increase the Docker builder memory limit or retry with smaller explicit heaps:

```bash
OPENCLAW_DOCKER_BUILD_NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB=4096
```

The explicit tsdown heap override is also the supported opt-in for attempting a build below the automatically detected safe minimum. That attempt may stall or fail.
