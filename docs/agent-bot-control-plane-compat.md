# Agent Bot Control-Plane Compatibility

This document tracks the local compatibility layer added for integrating
`/Users/lidongdong/iq/openclaw` with the current
`/Users/lidongdong/iq/agent-bot-task-a` control plane.

Search token for all compatibility edits:

```text
AGENT_BOT_COMPAT
```

## Goal

Use the newer upstream `openclaw` codebase as the runtime while keeping the
existing `agent-bot-task-a` architecture:

- `agent-bot-task-a` stays the control plane
- `portal-web` stays the experience plane
- `iq/openclaw` becomes the runtime plane
- `control ui` is intentionally left unchanged

## How To Run

From `/Users/lidongdong/iq/openclaw`:

```bash
pnpm install
pnpm build

export OPENCLAW_BRIDGE_TOKEN=change-me
export OPENCLAW_GATEWAY_PORT=15661
export OPENCLAW_CONTROL_PLANE_STATE_FILE="$PWD/.openclaw/control-plane-state.json"

pnpm gateway:dev
```

Notes:

- `OPENCLAW_BRIDGE_TOKEN` must match the token used by `agent-bot-task-a`
  when it calls `__control-plane/*`.
- `OPENCLAW_CONTROL_PLANE_STATE_FILE` stores workgroup/bootstrap/runtime sync
  state written by the compatibility layer.
- The runtime still serves its normal upstream Control UI and Web UI routes;
  the added bridge routes are separate and do not depend on the Control UI.

## How To Publish To A Target Mac

Use the local packaging script so the target machine installs THIS repository's
OpenClaw build instead of upstream `openclaw@latest`.

From `/Users/lidongdong/iq/openclaw`:

```bash
bash scripts/package-openclaw-mac.sh
```

This produces an archive like:

```text
openclaw-mac-bundle-20260325-xxxxxx.tar.gz
```

The archive includes:

- a tarball packed from the current local repository
- `~/.openclaw/openclaw.json`
- `~/.openclaw/exec-approvals.json`
- `~/.openclaw/workspace/SOUL.md`

On the target Mac:

1. Extract the archive.
2. Install the included local OpenClaw tarball with `npm install -g`.
3. Restore the bundled runtime profile.
4. Export `OPENCLAW_BRIDGE_TOKEN`.
5. Start `openclaw gateway --config ~/.openclaw/openclaw.json`.

Do not install upstream `openclaw@latest` for this scenario; that package will
miss the control-plane compatibility routes required by `agent-bot-task-a`.

## How To Connect It To `agent-bot-task-a`

The current control plane calls these runtime routes:

- `GET /__control-plane/runtime-context`
- `POST /__control-plane/bootstrap`
- `POST /__control-plane/skills/snapshot/apply`
- `POST /__control-plane/agents/sync`
- `POST /__control-plane/portal/sessions`
- `POST /__control-plane/portal/sessions/:remoteSessionId/messages`
- `POST /__control-plane/portal/sessions/:remoteSessionId/approvals/:approvalId/decision`

Optional compatibility routes also implemented:

- `POST /__control-plane/agents/deploy`
- `POST /__control-plane/agents/:remoteAgentId/release/export`
- `POST /__control-plane/agents/:remoteAgentId/undeploy`
- `GET /__control-plane/portal/runs/:runId`

To wire the runtime into the current base project:

1. Point the runtime/base URL in `agent-bot-task-a` to this gateway, for example
   `http://127.0.0.1:15661`.
2. Make sure the base sends the same `OPENCLAW_BRIDGE_TOKEN`.
3. Bootstrap a workgroup or runtime binding from the base.
4. Sync an agent from the base.
5. Start a portal session from the base and verify message execution.

## Files Added Or Changed

New compatibility files:

- `src/gateway/control-plane-http.ts`
- `src/gateway/control-plane-runtime.ts`
- `src/gateway/exec-approval-context.ts`

Small upstream hook points:

- `src/gateway/server-http.ts`
- `src/gateway/server.impl.ts`

## What Each Change Does

### `src/gateway/control-plane-runtime.ts`

Adds a small persisted runtime-state store for:

- workgroup and instance identity
- runtime role and session views
- current skill snapshot
- synced runtime agents
- release metadata used by the base

### `src/gateway/control-plane-http.ts`

Adds the control-plane bridge used by `agent-bot-task-a`:

- bootstrap
- skill snapshot apply
- runtime-context query
- agent sync/deploy
- release export/undeploy
- portal session create
- portal message execution
- portal approval callback

It also materializes synced agents locally by updating runtime config and
workspace files so upstream agent execution can still use normal runtime paths.

### `src/gateway/exec-approval-context.ts`

Exposes gateway exec approval state to the HTTP bridge so training-mode portal
requests can surface `requires_approval` and later resolve approvals.

### `src/gateway/server-http.ts`

Registers the compatibility HTTP handler as a normal gateway request stage,
before Control UI fallback handling.

### `src/gateway/server.impl.ts`

Publishes the shared exec approval manager/forwarder/broadcast references so
the HTTP bridge can participate in the same approval lifecycle as the gateway.

## Sync Strategy For Future Upstream Updates

When upstream `openclaw` changes, re-check these in order:

1. Search for `AGENT_BOT_COMPAT` and re-apply or re-validate only those hunks.
2. Verify `src/gateway/server-http.ts` still has a request-stage pipeline and
   keep the control-plane bridge outside Control UI routing.
3. Verify `src/gateway/server.impl.ts` still creates a single
   `ExecApprovalManager` and keep the compatibility context wired to it.
4. Re-check upstream signatures for:
   - `agentCommandFromIngress`
   - `ExecApprovalManager`
   - `resolveAgentDir`
   - `resolveAgentWorkspaceDir`
   - `ensureAgentWorkspace`
   - `loadConfig`
   - `writeConfigFile`
5. Re-run:

```bash
pnpm exec tsc -p tsconfig.json --noEmit --pretty false
```

Then filter only compatibility-file errors first.

## Known Validation Result

At the time this compatibility layer was added:

- the edited compatibility files were clean in IDE diagnostics
- filtered TypeScript checks for the edited compatibility files passed
- the repository still had pre-existing unrelated TypeScript issues outside the
  compatibility layer

## Recommended Smoke Test

After upgrading upstream, validate this exact flow:

1. `GET /__control-plane/runtime-context`
2. `POST /__control-plane/bootstrap`
3. `POST /__control-plane/skills/snapshot/apply`
4. `POST /__control-plane/agents/sync`
5. create a portal session
6. send one serving message
7. send one training message that triggers approval
8. resolve the approval from the base

If these pass, the current `agent-bot-task-a` integration should still work.
