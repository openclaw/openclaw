# System Patterns - OpenClaw Architecture

## Workspace Isolation

- **Rule:** Never use `~/.openclaw` for project-specific development.
- **Implementation:** Always set `OPENCLAW_STATE_DIR=$PROJECT_ROOT/workspace`.

## Memory System (Hybrid)

- **Engine:** LanceDB (Vector) + Knowledge Graph.
- **Config:** Must explicitly define `dbPath` to ensure it doesn't default to `$HOME`.

## Authentication (Gateway)

- **Bug Fix:** In `dangerouslyDisableDeviceAuth` mode, ensure the `message-handler.ts` is patched to allow `operator.read` scopes. Otherwise, the UI will be connected but "empty".

## Infrastructure & Service

- **PATH Handling:** The systemd service MUST include `.local/bin` in the `PATH` if using `pnpm`.
- **Permissions:** Run the service as `User=vova` to avoid root-ownership issues in the workspace.
- **Port:** Use `18789` for standard gateway compatibility.
