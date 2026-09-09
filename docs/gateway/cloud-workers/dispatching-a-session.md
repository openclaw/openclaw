---
summary: "Eligibility gates, the Control UI Place picker, cloud child sessions, and runtime support"
title: "Dispatching a cloud session"
read_when: "You are starting a session on a cloud profile, or a cloud destination is not offered."
---

How an authorized session reaches a cloud destination, what the Control UI requires before offering one, and which runtimes can use it.

## Dispatching a session

Administrators can run an authorized repository or managed-worktree session on a configured cloud profile. Session ownership and participation checks are revalidated before placement lifecycle changes commit.

In the Control UI, open **New Session** and use the unified **Place** picker to choose both the working folder and a **Cloud · profile** destination. A cloud destination appears only when all four eligibility gates pass:

1. The connected operator has `operator.admin` scope.
2. `environments.list` advertises at least one configured profile.
3. A GitHub repository is selected, or the selected Gateway folder is a Git checkout that can use a managed worktree.
4. The selected agent runtime advertises cloud placement support.

With a GitHub repository selected, **Remote checkout** lets you choose the source ref without cloning on the Gateway. With a Gateway folder selected, cloud selection enables its managed worktree. The Gateway creates the session, finishes dispatch, and only then sends the first turn. The server badge in the session sidebar shows the durable placement state. Startup recovery retains the repository URL and ref along with the destination and first message.

Choosing **Stop cloud worker…** while the new session is still provisioning pauses its initial message before requesting teardown. A late dispatch response cannot send that message. The draft stays visible for **Retry** and is not resubmitted automatically. Regular session drafts survive reconnects and page reloads; incognito drafts remain only in the current page. If the first message was already sent, uncertain delivery remains **Check delivery** rather than starting another turn.

While a placement is active, OpenClaw automatically samples available space on the remote workspace volume. Low-space warnings appear in the selected chat and on the session's cloud badge. They are advisory, clear automatically after space recovers, and do not stop or reclaim the worker.

### Cloud child sessions

When an OpenClaw worker uses `sessions_spawn`, the Gateway creates a visible child session in a separate managed worktree, provisions a worker with the parent's profile, and submits the initial task before returning acceptance. The call does not wait for the child task to finish.

While that call is waiting, the parent remains an active turn under its existing run timeout. Quiet provisioning alone does not let a queued message take over the parent or make recovery abort it early. Worker progress does not extend the timeout, and the chat **Stop** control or `/stop` can still cancel the turn. Use **Stop cloud worker…** separately to reconcile the workspace and release the machine.

### Runtime support

- **OpenClaw** uses `worker-turn` placement. The restricted `openclaw worker` process runs each turn on the leased node and proxies inference through the Gateway.
- **Codex** uses `remote-exec` placement on the same bundled Crabbox cloud profile, an eligible paired device, or a provider that advertises an SSH-backed execution carrier. The Gateway keeps the Codex app-server and authentication local; an enrolled cloud node runs only the explicitly authorized Codex exec-server and does not start an OpenClaw worker child.

The Control UI checks each cloud destination's advertised execution modes in both New Session and Move Session. One Crabbox **Cloud · profile** row is selectable for OpenClaw and Codex, while a genuinely single-mode provider stays disabled for the other runtime. An incompatible move is rejected before the active source starts draining or changes its durable placement.

Other runtimes remain unavailable unless their harness explicitly declares a cloud placement mode. Cloud targets are not offered for external CLI session catalogs. Remote-exec fails closed if the selected provider or placement sandbox is unavailable; it never falls back to running the operation on the Gateway host.
