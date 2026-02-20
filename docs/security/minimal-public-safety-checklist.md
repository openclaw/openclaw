# Minimal safety checklist (public-facing)

This page summarizes a **minimal, opinion-free baseline** that can be shared publicly.
It is intentionally generic so it can be adapted by other users without exposing internal deployment details.

## Goal

Keep tool-enabled assistants from taking unsafe actions when handling untrusted content.

## Minimal hardening rules

1. **Trust boundary first, never by model text alone**
   - Treat web/API/fetched/forwarded content as potentially untrusted.
   - Do not execute shell, filesystem, or service-control commands directly from fetched text.

2. **Require explicit operator approval for destructive actions**
   - Destructive command categories (delete/write/system-restart/control-plane actions) should require a separate approval path.
   - Default: block by default, allow only with a documented approval reason.

3. **Keep secrets out of user-visible channels**
   - Do not paste tokens/API keys into logs or external posts.
   - Apply redaction before publishing to issues/notes/chats.

4. **Keep access scoped and isolated**
   - Use pairing/allowlists for inbound messages.
   - Use tighter session scope when many users are possible.
   - Limit high-risk tools to dedicated operator agents.

5. **Reduce blast radius for untrusted workflows**
   - Prefer read-only summary workflows before write/execution workflows.
   - If external content must be ingested, run through a non-privileged path first.

6. **Prefer explicit “not trusted” handling for external input**
   - Mark web/imported content as untrusted and skip instruction execution in that path.
   - Use allow/deny lists for filesystem/network surfaces.

## Lightweight operational pattern

A safe rollout usually has three layers:

- **Ingress gate:** who can invoke, where, and at what permission level.
- **Execution gate:** dangerous operations are blocked until approved.
- **Publish gate:** sensitive output is sanitized before external posting.

## What to publish in open repos

For public templates/docs, include:

- policy principles (above)
- non-sensitive command categories
- example of approval workflow

Avoid publishing environment- or tenant-specific values, internal token names, or exact bypass traces.
