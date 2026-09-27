---
summary: "Eligibility gates, the Control UI Place picker, cloud child sessions, and runtime support"
title: "Dispatching a cloud session"
read_when: "You are starting a session on a cloud profile, or a cloud destination is not offered."
---

How an authorized session reaches a cloud destination, what the Control UI requires before offering one, and which runtimes can use it.

## Dispatching a session

Administrators can run an authorized session on a configured cloud profile, including a fresh workspace without a repository. Session ownership and participation checks are revalidated before placement lifecycle changes commit.

In the Control UI, open **New Session** and choose a **Cloud** destination. A cloud destination is available when these eligibility gates pass:

1. The connected operator has `operator.admin` scope.
2. `environments.list` advertises at least one configured profile.
3. The selected agent runtime advertises cloud placement support.

Without an explicitly selected folder, project, or worktree, remote sessions default to **New workspace**: an empty, isolated working directory. You can also choose **New workspace** from the project picker. No repository, initial commit, or Gateway folder is required. OpenClaw uses a private backing repository for each fresh session so workspace snapshots, recovery, and cleanup keep their normal behavior; sessions do not share Git remotes or history. Existing local files are not copied into the new workspace.

With a repository selected, the branch picker shows **From main** (or the selected branch); before a ref is selected, it shows **Starting branch**. With a GitHub repository selected, it lets you choose the source ref without cloning on the Gateway. With a Gateway folder selected, cloud selection enables its managed worktree and still requires that folder to be a usable Git checkout. Selecting a destination does not discard an explicit source while Git discovery is pending; choose **New workspace** to start empty instead. The Gateway creates the session, finishes dispatch, and only then sends the first turn. The server badge in the session sidebar shows the durable placement state. Startup recovery retains the workspace selection along with the destination and first message.

If the Gateway restarts during provisioning, the pending first message waits for recovery and continues automatically when its worker is ready. Temporary startup or suspension errors do not cancel setup. The first message stays before later recovery notices in the chat, including after reconnecting.

If startup recovery times out, the notice distinguishes setup still in progress from a Gateway that could not confirm completion, and confirms that the first message has not been sent. **Retry** checks the existing worker first. It waits for setup already in progress and sends the preserved first message once that worker is ready. A replacement is requested only when the placement permits a new dispatch; a failed worker that still needs cleanup must be stopped first. Reconnecting alone never requests a replacement.

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
