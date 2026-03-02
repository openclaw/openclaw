# Generic macOS Seatbelt Sandbox Backend — Spec + Implementation Plan

> **For the implementer:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Add a generic macOS-only sandbox backend using `sandbox-exec` (Seatbelt) starting from upstream release `v2026.2.26`, reaching parity with our fork’s *process + filesystem* sandboxing (but **not** the network proxy).

**Architecture:** Reuse the existing sandbox architecture (Docker backend) and add a second backend (`seatbelt`) that runs sandboxed execs on the host via `sandbox-exec`, with a native filesystem bridge. Access control is defined by a seatbelt profile selected via config (logical profile name → `${profileDir}/${name}.sb`).

**Tech Stack:** Node.js, TypeScript, OpenClaw gateway sandbox plumbing, macOS `sandbox-exec` + `.sb` profiles.

---

## Executive summary

We add:

- `sandbox.backend: "seatbelt" | "docker"` (default docker)
- `agents.*.sandbox.seatbelt.profile` **required when backend=seatbelt**
- `agents.*.sandbox.seatbelt.profileDir` (optional; defaults under `STATE_DIR/seatbelt-profiles`)
- Shipped demo profiles (logical names):
  - `demo-open` — permissive process exec + network allowed, deny writing seatbelt profile dir, deny reading other agents’ sessions
  - `demo-websearch` — permissive process exec + network allowed, *no access to workspace/state/user data*
  - `demo-restricted` — restrictive process exec + no network, RW only to workspace (intentionally “too locked down” demo)

We **do not** include the fork’s seatbelt proxy in v1.

We also fix a security/behavior gap:

- Today, exec allowlist/safeBins enforcement only runs in the `host=gateway` path.
- When `exec.host=sandbox`, the allowlist gate is bypassed.
- For v1 we will add **gateway-side allowlist enforcement for seatbelt sandbox runs** (backend=seatbelt) even when `host=sandbox`.

### Rationale: why seatbelt-only allowlist enforcement (not docker)

SafeBins/allowlist matching relies on resolving the executed binary’s path. With the docker backend the binary exists *inside the container*, so host-side resolution is not reliable without adding container-aware resolution (future work).

Seatbelt runs on the host filesystem, so resolving/allowlisting binaries is meaningful and can be enforced consistently.

---

## Goals

1. **Generic**: no hardcoded paths, no “our agents”, no reliance on our proxy/tokens/infra.
2. **Schema locality**: seatbelt config lives under `sandbox.seatbelt.*`.
3. **Least surprise**: seatbelt backend behaves like docker sandbox at the UX level:
   - workspace semantics consistent with `workspaceAccess` and sandbox scope
   - sandboxed `exec` works the same from the agent’s perspective
4. **Defense in depth**:
   - seatbelt profile is the OS-layer authority for filesystem/network/process operations
   - gateway exec allowlist enforced for seatbelt sandbox runs (even when host=sandbox)
5. **Reviewability**: PR includes this spec and reviewer checklist.

## Non-goals (v1)

- No network domain filtering proxy, no per-agent proxy tokens.
- No cross-sandbox (docker) allowlist enforcement for host=sandbox.
- No dynamic per-agent profile generation.

---

## Config: proposed schema changes

### Add sandbox backend selector

- `agents.defaults.sandbox.backend: "docker" | "seatbelt"` (default: docker)

### Add seatbelt config (schema-local)

Under `agents.defaults.sandbox.seatbelt` and per-agent overrides under `agents.list[].sandbox.seatbelt`:

- `profileDir: string` (default: `${STATE_DIR}/seatbelt-profiles`)
- `profile: string` (**required when backend=seatbelt**) — logical name (no `.sb` required)
- `params?: Record<string,string>` — extra `-D` key/values

#### Profile resolution

- If `profile` does not end with `.sb`, append `.sb`.
- Resolve `profilePath = path.join(profileDir, resolvedProfileFile)`.

### Required validation

On gateway startup (config load / validate stage):

- If any agent’s effective sandbox backend is `seatbelt` and effective seatbelt profile is missing/empty → **throw** with clear error:
  - what key is missing
  - example config snippet
  - mention `openclaw doctor`

- If platform is not macOS (`process.platform !== "darwin"`) and backend=seatbelt is configured → **throw** with clear error.

---

## Runtime behavior

### Workspace semantics

Seatbelt uses the same sandbox workspace layout logic as docker:

- When `workspaceAccess === "rw"` → sandbox workspace path is the agent workspace directory.
- When `workspaceAccess !== "rw"` → sandbox workspace path is the sandbox workspace directory under the sandbox workspace root.

The seatbelt profile should gate filesystem access primarily via `PROJECT_DIR` (mapped to the effective sandbox `workspaceDir`).

### HOME semantics

Keep `HOME` = real user home (compatibility / Keychain), but seatbelt profile is the authority for whether access is allowed.

### Seatbelt `-D` parameters

Populate these automatically when backend=seatbelt:

- `PROJECT_DIR` = effective sandbox workspace dir
- `WORKSPACE_DIR` = agent’s workspace dir
- `STATE_DIR` = OpenClaw state dir
- `AGENT_ID` = effective agent id
- `SEATBELT_PROFILE_DIR` = effective profileDir
- `WORKSPACE_ACCESS` = `rw` | `ro` | `none`
- `TMPDIR` = "/tmp"

Merge user-provided `seatbelt.params` after the auto-generated base (user keys override).

### Filesystem bridge

Implement a native fs bridge for seatbelt backend that uses Node `fs` directly (no container mapping). Still enforce `workspaceAccess` at the tool layer (matching docker’s “second guard”).

### Exec allowlist enforcement (seatbelt only)

When `exec` runs with `host=sandbox` AND `sandbox.backend=seatbelt`:

- Apply the existing allowlist/safeBins analysis before running `sandbox-exec`.
- If effective exec security is `allowlist` and allowlist is not satisfied → deny.
- If safeBins satisfied → generate an enforced command plan and run it.

This should not change docker behavior in v1.

---

## Demo profiles to ship

All demo profiles are optional examples; users can (and should) customize.

### `demo-open`

Intent: “developer-friendly” default for mac users.

- `process-exec`: permissive
- `network`: allow
- `filesystem`: allow broadly, but explicitly deny:
  - writes to `${SEATBELT_PROFILE_DIR}`
  - reads of other agents’ session dirs under `${STATE_DIR}/agents/*/sessions` except its own `${STATE_DIR}/agents/${AGENT_ID}/sessions`

### `demo-websearch`

Intent: network-only style profile.

- `process-exec`: permissive
- `network`: allow
- `filesystem`: deny access to user/workspace/state data:
  - deny reads/writes to `${PROJECT_DIR}`
  - deny reads/writes to `${STATE_DIR}`
  - allow only minimal system libs + `/tmp` needed to run

### `demo-restricted`

Intent: “how to lock it down” demonstration; likely unusable without customization.

- `process-exec`: restrictive (explicit allowlist; minimal)
- `network`: deny
- `filesystem`:
  - allow file-read* to `${PROJECT_DIR}`
  - allow file-write* to `${PROJECT_DIR}` only when `WORKSPACE_ACCESS == "rw"`
  - deny file-write* to `${PROJECT_DIR}` when `WORKSPACE_ACCESS == "ro"`

> Document loudly that this profile is intentionally extremely restrictive.

---

## Reviewer checklist (genericness)

Reviewers should confirm:

- No hardcoded absolute paths (no `/Users/<name>` etc).
- No references to our proxy/tokens/per-agent proxy lifecycle.
- No references to our internal agent names/roles.
- Profiles use only `param` variables (`PROJECT_DIR`, `STATE_DIR`, etc).
- Any denies of session/history are generic (`${STATE_DIR}/agents/...`), not bespoke.
- Allowlist enforcement added only for seatbelt backend, with explicit rationale.

---

## Implementation plan (bite-sized tasks)

### Task 0: Branch setup

**Goal:** Start feature branch from release tag.

**Steps:**
1. Create branch from `v2026.2.26` (not beta):
   - `git checkout -b feat/seatbelt-sandbox-generic v2026.2.26`
2. Add this doc to repo at `docs/plans/2026-02-26-generic-seatbelt-sandbox.md` and commit first.

### Task 1: Add config types for seatbelt backend

**Files (expected):**
- Modify: `src/config/types.sandbox.ts`
- Modify: `src/config/types.agents-shared.ts` (or wherever AgentSandboxConfig is defined)
- Modify: zod schema(s) validating sandbox config

**Steps:**
1. Add `backend?: "docker" | "seatbelt"` to sandbox config.
2. Add `seatbelt?: { profileDir?: string; profile?: string; params?: Record<string,string> }`.
3. Add validation: if backend=seatbelt then `seatbelt.profile` must be present.
4. Add validation: backend=seatbelt only on darwin.
5. Tests: add unit tests for config validation errors.

### Task 2: Add seatbelt sandbox types + context wiring

**Files (expected):**
- Modify: `src/agents/sandbox/types.ts`
- Add: `src/agents/sandbox/types.seatbelt.ts`
- Modify: `src/agents/sandbox/config.ts`
- Modify: `src/agents/sandbox/context.ts`

**Steps:**
1. Extend `SandboxBackend` union to include `seatbelt`.
2. Resolve effective seatbelt config (`profileDir/profile/params`).
3. In sandbox context resolution: if backend=seatbelt, return a sandbox context without creating a docker container.
4. Populate `-D` params (PROJECT_DIR, STATE_DIR, etc) + WORKSPACE_ACCESS.

### Task 3: Add native FS bridge for seatbelt backend

**Files:**
- Add: `src/agents/sandbox/seatbelt-fs-bridge.ts`
- Modify: `src/agents/sandbox/context.ts` to attach fsBridge

**Steps:**
1. Implement SandboxFsBridge with direct `fs` calls.
2. Enforce workspaceAccess at tool layer (deny writes when ro).
3. Tests for read/write behavior.

### Task 4: Seatbelt exec runtime support (no proxy)

**Files:**
- Modify: `src/agents/bash-tools.exec-runtime.ts`
- Modify: `src/agents/bash-tools.shared.ts`

**Steps:**
1. Add `sandbox-exec` argv path for backend=seatbelt.
2. Remove any proxy env injection (v1).
3. Ensure env export includes `HOME` real home (compat).

### Task 5: Shipped demo profiles + install/copy logic

**Files:**
- Add: `assets/seatbelt-profiles/demo-open.sb`
- Add: `assets/seatbelt-profiles/demo-websearch.sb`
- Add: `assets/seatbelt-profiles/demo-restricted.sb`
- Add/Modify: a startup hook to ensure `${STATE_DIR}/seatbelt-profiles` exists and copy demo profiles if missing.

**Steps:**
1. Decide source location inside repo for demo profiles (assets folder).
2. On gateway startup, copy profiles into profileDir if file missing.
3. Document customization instructions.

### Task 6: Enforce exec allowlist/safeBins for seatbelt sandbox runs

**Files:**
- Modify: `src/agents/bash-tools.exec.ts` and/or a shared helper

**Steps:**
1. If `host=sandbox` and backend=seatbelt, run allowlist analysis.
2. If allowlist mode and not satisfied → deny.
3. If satisfied by safeBins/allowlist → compute enforced command and run.
4. Add unit tests that demonstrate:
   - allowlist miss blocks
   - safeBins allowed passes

### Task 7: Documentation

**Files:**
- Add: `docs/sandbox/seatbelt.md` (or best docs location)

**Must include:**
- Config examples
- Demo profiles explanation
- “restricted is intentionally too locked down” callout
- allowlist enforcement rationale (seatbelt-only)

### Task 8: Final verification

Run:
- unit tests covering sandbox + config validation
- build
- smoke test: run a seatbelt-sandboxed exec on mac

---

## Handoff notes for PR

- This doc must be included in the PR (committed to the repo).
- PR description should call out non-goals and future work.
