---
summary: "Building the default, common, and browser sandbox images, and the network and certificate defaults"
title: "Images and setup"
read_when: "You need to build or customize a sandbox image."
---

Building the sandbox images from a source checkout or an npm install, and the network and certificate defaults that shape what an image must already contain.

## Images and setup

Default Docker image: `openclaw-sandbox:trixie-slim`

The bundled images use Debian 13 (trixie). After upgrading from the previous
Bookworm defaults, build the trixie images before starting new sandboxes. Explicit
custom image settings stay unchanged; update them only when you want to switch
images, then [recreate the affected sandboxes](/cli/sandbox#openclaw-sandbox-recreate).

<Note>
**Source checkout vs npm install**

The npm package includes the standalone `scripts/sandbox-image-build.sh` builder
and the default Dockerfile. `openclaw doctor --fix` locates this builder in the
installed package, so you can run it from any directory with Docker available.
Doctor skips image checks when sandbox mode is `off` (the default).

The common and browser image builders still require a [source checkout](https://github.com/openclaw/openclaw)
or the manual build instructions below.
</Note>

<Steps>
  <Step title="Build the default image">
    From a source checkout:

    ```bash
    scripts/sandbox-setup.sh
    ```

    From an npm install with Docker sandboxing already enabled (no source checkout needed):

    ```bash
    openclaw doctor --fix
    ```

    For a fresh install, first configure the Docker backend and enable sandboxing
    by setting `agents.defaults.sandbox.mode` to `non-main` or `all`, then run
    Doctor and accept the image build. See [Sandboxing](/gateway/sandboxing) for
    mode selection.

    To provision the image before enabling sandboxing, run the packaged builder
    directly. For a global npm install:

    ```bash
    bash "$(npm root -g)/openclaw/scripts/sandbox-image-build.sh"
    ```

    For a local npm install, use that installation's
    `node_modules/openclaw/scripts/sandbox-image-build.sh` path instead.

    The default image does **not** include Node. If a skill needs Node (or other runtimes), either bake a custom image or install via `sandbox.docker.setupCommand` (requires network egress + writable root + root user).

    OpenClaw does not silently substitute plain `debian:trixie-slim` when `openclaw-sandbox:trixie-slim` is missing. Sandbox runs that target the default image fail fast with a build instruction until you build it, because the bundled image carries `python3` for the sandbox write/edit helpers.

    Doctor reports a missing default image as an update warning. Updates continue;
    image builds remain a separate runtime repair. OpenClaw also does not silently
    reuse a previous Bookworm image: its operating system and installed tools differ
    from this version's default. An explicit `sandbox.docker.image` setting remains
    the operator's choice.

  </Step>
  <Step title="Optional: build the common image">
    For a more functional sandbox image with common tooling (for example `curl`, `jq`, Node 24, pnpm, `python3`, and `git`):

    With `INSTALL_NODE=1` (the default), the image also provisions Chromium's Linux system libraries and fonts through the Playwright version pinned in `package.json`. Projects install their own matching browser executables in a writable workspace or cache. `INSTALL_NODE=0` skips this browser dependency step.

    From a source checkout:

    ```bash
    scripts/sandbox-common-setup.sh
    ```

    From an npm install, build the default image first (see above). Download [`scripts/docker/sandbox/Dockerfile.common`](https://github.com/openclaw/openclaw/blob/main/scripts/docker/sandbox/Dockerfile.common) and the root [`package.json`](https://github.com/openclaw/openclaw/blob/main/package.json) from the same OpenClaw commit or tag into an empty directory. Keep their filenames, then run from that directory:

    ```bash
    docker build -t openclaw-sandbox-common:trixie-slim -f Dockerfile.common .
    ```

    `package.json` supplies the pinned pnpm and Playwright versions and must be in the build context, even with `--build-arg INSTALL_PNPM=0`. It is a read-only build input; you do not need a source checkout or a host pnpm installation.

    Then set `agents.defaults.sandbox.docker.image` to `openclaw-sandbox-common:trixie-slim`.

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

Dependency-template builders keep `HOME` and XDG configuration, data, state, and
cache directories in a private writable tmpfs outside the workspace. Package-manager
state is discarded with the builder and is not staged as workspace content. This
does not supply registry metadata or packages for offline installs. Runtime tool
containers retain the image and `sandbox.docker.env` settings; custom images with a
missing or read-only home need writable HOME/XDG paths for tools that write there.

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
