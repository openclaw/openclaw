---
summary: "Use an externally managed Lightpanda browser for JavaScript and DOM tasks"
title: "Lightweight browsers"
read_when:
  - You want browser tasks to use a lightweight engine instead of Chromium
  - You run OpenClaw or its browser in Docker
  - You need the limits of the Lightpanda browser profile
---

# Lightweight browsers

Lightpanda is an opt-in engine for text and DOM browser tasks. It uses the same
OpenClaw `browser` tool through an explicitly configured profile. It is not a
visual-browser replacement: keep a Chromium profile for screenshots, PDF output,
and applications that require unsupported browser features.

The examples pin Lightpanda **0.4.1**. They do not change your existing browser
profile, install a service, or migrate a logged-in Chrome profile.

## Choose where the engine runs

| OpenClaw location       | Lightpanda location                              | Profile CDP URL        |
| ----------------------- | ------------------------------------------------ | ---------------------- |
| Host, including Windows | Docker/Podman with a loopback-published port     | `ws://127.0.0.1:9222`  |
| Linux or macOS host     | Native binary on the same host                   | `ws://127.0.0.1:9222`  |
| Docker Compose          | Sidecar in the same Compose project              | `ws://lightpanda:9222` |
| WSL                     | Native Linux binary in the same WSL distribution | `ws://127.0.0.1:9222`  |

`localhost` inside an OpenClaw container means that container, not the host and
not the Lightpanda sidecar. Use the service name for container-to-container
connections. On Windows, run Docker Desktop in **Linux container** mode, or run
both OpenClaw and the Linux engine inside WSL. Lightpanda does not publish a native
Windows binary. macOS and Linux have official x86-64 and ARM64 release binaries;
the official container image has Linux amd64 and arm64 variants.
[Upstream installation information](https://github.com/lightpanda-io/browser#install).

## Docker with OpenClaw on the host

From the repository root:

```sh
docker compose -f deploy/lightpanda/compose.yaml -f deploy/lightpanda/compose.host.yaml up -d
docker compose -f deploy/lightpanda/compose.yaml -f deploy/lightpanda/compose.host.yaml exec lightpanda /bin/lightpanda version
```

The sample publishes CDP on `127.0.0.1:9222` only. Set `LIGHTPANDA_PORT` to select
another host port, and update the profile URL to match. The image is pinned by its
multi-platform digest, so Docker selects the host architecture without pulling a
moving `latest` or `nightly` version.

CDP gives a client control over the browser; the sample does not add CDP
authentication. Do not change the loopback binding to a public address. Use an
authenticated tunnel for access from another host.

To stop and remove only this sample's container and network:

```sh
docker compose -f deploy/lightpanda/compose.yaml -f deploy/lightpanda/compose.host.yaml down
```

## Docker Compose with OpenClaw in a container

Merge the sidecar into the repository's existing Compose project:

```sh
docker compose -f docker-compose.yml -f deploy/lightpanda/compose.yaml up -d lightpanda
```

Configure the OpenClaw Gateway with `cdpUrl: "ws://lightpanda:9222"` in the profile
below. Use the same Compose files and project name when starting the Gateway.
No browser port is published to the host in this variant. The containers share
the project's bridge network and retain outbound internet access; the network
is not declared `internal: true` because that would prevent public-site browsing.

Use your normal OpenClaw Docker setup for its state directory, authentication,
and Gateway startup. The sidecar does not mount your OpenClaw state, browser
cookies, or host Docker socket.

For Podman, use an installed Compose provider and verify service-name DNS before
choosing the sidecar URL. A netavark installation without its `aardvark-dns`
helper can start a loopback-published engine while leaving container DNS broken;
successful engine startup does not prove sidecar connectivity.

## Native Linux and macOS

Download the release binary for your operating system and CPU from
[Lightpanda 0.4.1](https://github.com/lightpanda-io/browser/releases/tag/0.4.1).
The sample's `deploy/lightpanda/SHA256SUMS` records the release asset digests.

For Linux x86-64, run from the repository root:

```sh
curl --fail --location --output lightpanda-x86_64-linux https://github.com/lightpanda-io/browser/releases/download/0.4.1/lightpanda-x86_64-linux &&
  sha256sum --check --ignore-missing deploy/lightpanda/SHA256SUMS &&
  chmod +x lightpanda-x86_64-linux &&
  LIGHTPANDA_DISABLE_TELEMETRY=1 LIGHTPANDA_DISABLE_CORE_DUMP=1 ./lightpanda-x86_64-linux serve --host 127.0.0.1 --port 9222
```

For macOS Apple silicon:

```sh
curl --fail --location --output lightpanda-aarch64-macos https://github.com/lightpanda-io/browser/releases/download/0.4.1/lightpanda-aarch64-macos &&
  shasum --algorithm 256 --check --ignore-missing deploy/lightpanda/SHA256SUMS &&
  chmod +x lightpanda-aarch64-macos &&
  LIGHTPANDA_DISABLE_TELEMETRY=1 LIGHTPANDA_DISABLE_CORE_DUMP=1 ./lightpanda-aarch64-macos serve --host 127.0.0.1 --port 9222
```

Use `lightpanda-aarch64-linux` for Linux ARM64 or
`lightpanda-x86_64-macos` for Intel macOS. Only execute the downloaded binary after
its checksum matches. Linux release binaries require glibc; use the official
container image on musl-based systems such as Alpine. These commands run the
engine in the foreground; stop it with Ctrl+C.

## Configure an opt-in profile

Merge this browser block into your existing configuration:

```json5
{
  browser: {
    profiles: {
      lightpanda: {
        engine: "lightpanda",
        cdpUrl: "ws://127.0.0.1:9222",
        attachOnly: true,
      },
    },
  },
}
```

Use `profile: "lightpanda"` on browser tool calls. When the selected workload has
passed your checks, set `browser.defaultProfile` to `"lightpanda"` to make it the
default. Preserve your Chromium profile and select it explicitly for visual or
unsupported work. Restore the previous `defaultProfile` to undo the selection.

`engine` declares the capability contract; a CDP endpoint alone does not imply
Chromium compatibility. `attachOnly` means OpenClaw attaches to the service you
started instead of launching or taking ownership of a local Chrome process.
Do not set `executablePath` to Lightpanda: its CLI is not Chrome's launch CLI.

## Session and capability limits

- A Lightpanda CDP connection owns its page state. Closing the connection, stopping
  the container, or restarting the engine loses that state; reconnecting does not
  resume the previous page or login.
- One CDP connection supports one page target. Separate connections can coexist,
  but a Lightpanda profile is not a general multi-tab Chromium session.
- No automatic cross-engine replay occurs after an action fails. A click or form
  submission may already have happened; inspect its outcome before repeating it.
- Lightpanda's text-layout preview is not a rendered screenshot. It cannot prove
  CSS, image, font, or visual-layout correctness.
- The verified snapshot path is AI format with `aria` references. The engine
  selects those references by default, including efficient snapshot mode.
  Explicit role references, selector/frame-scoped snapshots, labeled screenshots,
  and the separate `aria` snapshot format are unsupported in this adapter.
- JavaScript and web APIs are not a guarantee that every website will work.
  Verify the sites and interaction patterns you actually use.

The engine and its session model are documented in the
[pinned Lightpanda source](https://github.com/lightpanda-io/browser/tree/0.4.1).
See [browser profiles](/tools/browser/profiles) and
[remote browsers](/tools/browser/remote) for the shared profile and routing rules.

## Verification and benchmarks

Engine startup, CDP connectivity, task completion, and full OpenClaw integration
are separate checks. A running container or a successful `Browser.getVersion`
does not prove that snapshots, references, and actions work through OpenClaw.

Run the opt-in synthetic route benchmark from the repository root after
installing development dependencies:

```sh
node --import ./scripts/tsx.mjs extensions/browser/scripts/bench-lightweight.ts --lightpanda /path/to/lightpanda --chromium /path/to/chrome --iterations 10 --output lightweight-benchmark.json
```

Either binary flag can be used alone. The script creates isolated OpenClaw
state and browser data, serves a local form, then verifies navigation, the default
efficient AI snapshot, reference-based typing/clicking, exactly one form
submission, waiting, and text extraction through the browser route dispatcher.
The Chromium baseline uses OpenClaw's managed headless launch flags and disables
the sandbox for this isolated local fixture; it does not change production
browser configuration. Minimal Linux hosts still need Chromium's shared
libraries and fonts. A task-local installation can be selected using
`LD_LIBRARY_PATH` and `FONTCONFIG_FILE` without changing the host's packages.
Lightpanda additionally checks unsupported-operation rejection, its single-page
limit, and stale-target rejection after disconnecting. These checks do not use
an LLM and do not measure model reasoning or end-to-end agent token cost.

`--iterations` accepts 1 through 100 and counts **warm tasks**. A separate first
task includes the initial page open and CDP attachment; every warm task includes
navigation and the same form workflow. Native runs also report process startup
and time from startup through the first completed task. Warm percentiles exclude
the first task. Capability/session checks run after the measurement window.

A combined run uses one Node controller and records engine order; its later
engine can reuse controller modules already loaded by the earlier engine. The
first-task and process-start figures are not cold CLI/controller measurements.
Use separate invocations when comparing independently initialized controllers.

The memory fields are **maximum sampled process-tree PSS/RSS**, not true peaks.
They use Linux `/proc` with sampling attempts every 50 ms and at task boundaries.
Short-lived processes or transient allocations can be missed. Unsupported hosts
and externally managed engines report `null`, as do runs with unreadable process
memory, never a guessed engine-memory
figure. Controller RSS is a separate end-of-workload sample, not incremental
controller overhead; do not add independently sampled maxima and call the sum
total peak host memory.

### An externally managed engine

Use a dedicated engine instance. External mode closes the benchmark's control
connection and its own Chromium tab, but does not stop the engine process:

```sh
node --import ./scripts/tsx.mjs extensions/browser/scripts/bench-lightweight.ts --endpoint ws://127.0.0.1:9222 --engine lightpanda --fixture-bind 0.0.0.0 --fixture-host host.docker.internal --iterations 10 --output lightweight-container-benchmark.json
```

This example addresses a Docker Desktop engine from its host. The synthetic
fixture listener is explicitly exposed on the host so the container can reach
it; `--fixture-host` must name the controller from the browser's network, not
from the controller's own network. Linux Docker needs a reachable host address
or a configured `host-gateway` mapping. The default fixture listener/hostname
remain `127.0.0.1` when those flags are omitted.

External mode reports engine startup and memory as `null`. Capture the pinned
container/binary version separately with the report. A Windows Node controller
can use the same external-engine interface, but Windows Docker runtime behavior
has not been verified for this sample.

Compare the same deterministic tasks with a pinned Chromium baseline. Record
task completion before reporting speed or memory improvements; unsupported or
failed work must not be counted as a successful fast result. Report warm and
cold runs separately, engine versions, host OS/architecture, client overhead,
and whether memory includes the whole process tree or container.

For Docker Desktop, container memory does not include the VM's host overhead.
Do not compare a native-process RSS figure with a container-only figure and call
the difference total host savings. Keep all benchmark fixtures public or local;
do not export an existing logged-in browser profile to make a benchmark pass.

Platform support listed above describes upstream distribution and the deployment
topologies, not a claim that every platform has passed the same runtime tests.
Record actual platform and container-runtime results with the benchmark report.
