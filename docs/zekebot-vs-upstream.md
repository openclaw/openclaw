---
summary: "ZekeBot fork differences from upstream OpenClaw"
read_when:
  - You are reviewing ZekeBot Dockerfile changes
  - You are cherry-picking upstream Docker changes into ZekeBot
  - You need to verify ZekeBot image persistence behavior
title: "ZekeBot versus upstream OpenClaw"
---

# ZekeBot Versus Upstream OpenClaw

ZekeBot is a Zeke-operated fork of OpenClaw. The default policy is to stay stock-equivalent with upstream and record every intentional local difference here before it becomes operationally relevant.

## Docker Image Differences

### Persistent OpenClaw State Volume

ZekeBot declares `/home/node/.openclaw` as a Docker volume in `Dockerfile`.

Upstream already pre-creates this directory with `node:node` ownership and mode `0700`. ZekeBot keeps that setup and adds the explicit volume declaration so container replacement is less likely to discard agent config, session data, and local runtime state.

Verification:

- `docker inspect <image> --format '{{json .Config.Volumes}}'` includes `/home/node/.openclaw`.
- `docker run --rm <image> stat -c '%U:%G %a' /home/node/.openclaw` returns `node:node 700`.

Rollback:

- Remove the `VOLUME ["/home/node/.openclaw"]` line from `Dockerfile` and rebuild the image.

### Digest-Pinned Node Base Images

The current forked `Dockerfile` already uses digest-pinned Node base images for both build and runtime stages:

- `node:24-bookworm@sha256:...`
- `node:24-bookworm-slim@sha256:...`

S4 keeps those upstream pins rather than introducing a second pinning mechanism. Future upstream merges that touch the base-image arguments must preserve digest pins or document an explicit exception in this file.

## Merge Guidance

When cherry-picking upstream Dockerfile changes, compare the final `Dockerfile` against this page. If upstream changes conflict with a recorded ZekeBot difference, either preserve the ZekeBot behavior or update this page with the new decision and rollback path.

## Native Zeke Plugin Differences

ZekeBot bundles the `zeke` plugin under `extensions/zeke/`. The plugin registers native OpenClaw tools that forward to ZekeFlow authority APIs.

The plugin must not write Zeke state directly. It does not own events, pending proposals, Cognee memory, signal rows, or context policy. Those remain ZekeFlow responsibilities.

Initial native tools:

- `ask_zeke_context`
- `search_zeke_context`
- `explain_zeke_context_route`
- `read_zeke_source`
- `read_repo_file`
- `grep_repo`
- `glob_repo`
- `propose_signal`

`create_signal` is backend-only and must not be exposed in a model-facing catalog.

## Profile Differences

ZekeBot carries profile templates under `profiles/`.

| Profile           | Purpose                         | Internal Zeke tools      |
| ----------------- | ------------------------------- | ------------------------ |
| `sprout`          | Internal Chief of Staff runtime | Initial native Zeke set. |
| `rambo-internal`  | Internal operational runtime    | Context subset only.     |
| `external-client` | Future tenant/client baseline   | None.                    |

Upstream merge reviews must check whether changes affect plugin loading, tool catalog projection, gateway tool invocation, profile parsing, hooks, or config reload behavior. If they do, the change is not a trivial cherry-pick.

## Authority API Difference

Native Zeke tools call ZekeFlow instead of executing Zeke work in the fork. Per-profile tokens bind runtime identity, and ZekeFlow derives caller/entity/profile server-side.

Same-chat signal proposal approval also requires a signed operator reply path. Model-visible text alone is not authority.
