---
summary: "Building the default, common, and browser sandbox images, and the network and certificate defaults"
title: "Images and setup"
read_when: "You need to build or customize a sandbox image."
---

Building the sandbox images from a source checkout or an npm install, and the network and certificate defaults that shape what an image must already contain.

## Images and setup

Default Docker image: `openclaw-sandbox:bookworm-slim`

<Note>
**Source checkout vs npm install**

The `scripts/sandbox-setup.sh`, `scripts/sandbox-common-setup.sh`, and `scripts/sandbox-browser-setup.sh` helper scripts are only available when running from a [source checkout](https://github.com/openclaw/openclaw). They are not included in the npm package.

If you installed the global OpenClaw npm package, use the inline `docker build`
commands shown below instead.
</Note>

<Steps>
  <Step title="Build the default image">
    From a source checkout:

    ```bash
    scripts/sandbox-setup.sh
    ```

    From an npm install (no source checkout needed):

    ```bash
    docker build -t openclaw-sandbox:bookworm-slim - <<'DOCKERFILE'
    FROM debian:bookworm-slim
    ENV DEBIAN_FRONTEND=noninteractive
    RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq python3 ripgrep \
      && rm -rf /var/lib/apt/lists/*
    RUN useradd --create-home --shell /bin/bash sandbox
    USER sandbox
    WORKDIR /home/sandbox
    CMD ["sleep", "infinity"]
    DOCKERFILE
    ```

    The default image does **not** include Node. If a skill needs Node (or other runtimes), either bake a custom image or install via `sandbox.docker.setupCommand` (requires network egress + writable root + root user).

    OpenClaw does not silently substitute plain `debian:bookworm-slim` when `openclaw-sandbox:bookworm-slim` is missing. Sandbox runs that target the default image fail fast with a build instruction until you build it, because the bundled image carries `python3` for the sandbox write/edit helpers.

  </Step>
  <Step title="Optional: build the common image">
    For a more functional sandbox image with common tooling (for example `curl`, `jq`, Node 24, pnpm, `python3`, and `git`):

    From a source checkout:

    ```bash
    scripts/sandbox-common-setup.sh
    ```

    From an npm install, build the default image first (see above). Download [`scripts/docker/sandbox/Dockerfile.common`](https://github.com/openclaw/openclaw/blob/main/scripts/docker/sandbox/Dockerfile.common) and the root [`package.json`](https://github.com/openclaw/openclaw/blob/main/package.json) from the same OpenClaw commit or tag into an empty directory. Keep their filenames, then run from that directory:

    ```bash
    docker build -t openclaw-sandbox-common:bookworm-slim -f Dockerfile.common .
    ```

    `package.json` supplies the pinned pnpm version and must be in the build context, even with `--build-arg INSTALL_PNPM=0`. It is a read-only build input; you do not need a source checkout or a host pnpm installation.

    Then set `agents.defaults.sandbox.docker.image` to `openclaw-sandbox-common:bookworm-slim`.

  </Step>
  <Step title="Optional: build the sandbox browser image">
    From a source checkout:

    ```bash
    scripts/sandbox-browser-setup.sh
    ```

    The npm package does not include the browser Dockerfile or entrypoint. Use a source checkout to build this image.

  </Step>
</Steps>

By default, local container sandboxes run with **no network**. Override with `agents.defaults.sandbox.docker.network`.

The default-off [secret egress proxy](/gateway/secrets#secret-egress-proxy) is Gateway-loopback only. Sandbox exec receives neither its proxy/CA environment nor protected sentinels. Sandbox/container proxy reachability is not implemented; do not enable sandbox networking expecting secret substitution to work in this release.

<Note>
System package installation and certificate-store changes are image provisioning,
not normal sandbox-turn behavior. The defaults deliberately combine no network,
a read-only root filesystem, and a non-root image user, so an in-turn system package
install should fail. Project-local dependencies can be installed in a writable
workspace when the operator enables network egress. Prefer a custom image that
already contains system packages and private certificate roots. If a Node process needs a private CA, also configure
the CA path for Node, for example with `NODE_EXTRA_CA_CERTS`, through the custom
image or `sandbox.docker.env`.
</Note>

<AccordionGroup>
  <Accordion title="Sandbox browser Chromium defaults">
    The bundled sandbox browser image applies conservative Chromium startup flags for containerized workloads:

    - `--remote-debugging-address=127.0.0.1`
    - `--remote-debugging-port=<derived from OPENCLAW_BROWSER_CDP_PORT>`
    - `--user-data-dir=${HOME}/.chrome`
    - `--no-first-run`
    - `--no-default-browser-check`
    - `--disable-dev-shm-usage`
    - `--disable-background-networking`
    - `--disable-breakpad`
    - `--disable-crash-reporter`
    - `--no-zygote`
    - `--metrics-recording-only`
    - `--password-store=basic`
    - `--use-mock-keychain`
    - `--headless=new` when `browser.headless` is enabled.
    - `--no-sandbox --disable-setuid-sandbox` (always enabled in the sandbox browser container).
    - `--disable-3d-apis`, `--disable-gpu`, `--disable-software-rasterizer` by default; these graphics-hardening flags help containers without GPU support. Set `OPENCLAW_BROWSER_DISABLE_GRAPHICS_FLAGS=0` if your workload needs WebGL or other 3D features.
    - `--disable-extensions` by default; set `OPENCLAW_BROWSER_DISABLE_EXTENSIONS=0` for extension-reliant flows.
    - `--renderer-process-limit=2` by default; controlled by `OPENCLAW_BROWSER_RENDERER_PROCESS_LIMIT=<N>`, where `0` keeps Chromium's default.

    If you need a different runtime profile, use a custom browser image and provide your own entrypoint. For local (non-container) Chromium profiles, use `browser.extraArgs` to append additional startup flags.

  </Accordion>
  <Accordion title="Network security defaults">
    - `network: "host"` is blocked.
    - `network: "container:<id>"` is blocked by default (namespace join bypass risk).
    - Break-glass override: `agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin: true`.

  </Accordion>
</AccordionGroup>

Docker installs and the containerized gateway live here: [Docker](/install/docker)

For Docker gateway deployments, `scripts/docker/setup.sh` can bootstrap sandbox config. Set `OPENCLAW_SANDBOX=1` (or `true`/`yes`/`on`) to enable that path. Override the socket location with `OPENCLAW_DOCKER_SOCKET`. Full setup and env reference: [Docker](/install/docker#agent-sandbox).
