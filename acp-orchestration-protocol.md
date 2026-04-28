# ACP Orchestration Protocol

This protocol defines the strict operational procedure for the Assistant when delegating tasks to an ACP session (via the `sessions_spawn` tool). It addresses the structural limitation where the Assistant cannot receive background wake-ups.

## The Core Problem & Hard Truth

1. **No Background Wake-up:** On this platform/surface, native background wake-up for the assistant after ACP completion is **not available**.
2. **No Thread-Bound Sessions:** Thread-bound ACP sessions are also unavailable here.

Therefore, the Assistant will **never** spontaneously "wake up" to proactively return the final result to the user if its execution turn has ended.

## Required Procedures (Machine-Checkable)

To mitigate this fundamental platform gap, the Assistant MUST use one of the two strategies below, depending on the user's implicit or explicit expectations.

### Strategy A: Synchronous / Blocking (Default)

**Use this by default when the user expects a proactive final reply.** This ensures the user receives a single synthesized final response without manual reprompting.

1. **Spawn the Job:** Use `sessions_spawn` tool (runtime="acp", appropriate `agentId`, mode="run").
2. **DO NOT Reply to User:** Do not yield an intermediate text message (e.g., "I have started the job").
3. **Record in Ledger:** Register the newly spawned `childSessionKey` in `acp-ledger.json`.
4. **Block and Wait:** Immediately use the `exec` tool to run `scripts/wait_for_acp_job.py --session-key <childSessionKey> --update-ledger`. This blocks the Assistant's execution turn until the job completes.
5. **Retrieve Result:** Once the `exec` command returns (exit code 0), use `sessions_history` tool to retrieve the final messages.
6. **Synthesize Final Response:** Only now, yield the synthesized final text response to the user.

By blocking its own execution turn with a generic polling script, the Assistant ensures it retains control and can proactively deliver the final result.

### Strategy B: Asynchronous OS Notification (Opt-in / Limited)

**Use this ONLY when the user explicitly asks for a long-running background task, or indicates they don't want to wait.** In this mode, the Assistant cannot proactively reply and true background wake-up does NOT exist.

1. **Spawn the Job:** Use `sessions_spawn` tool.
2. **Record in Ledger:** Register the `childSessionKey` in `acp-ledger.json`.
3. **Start Watchdog via Standard Detachment:** Use the `exec` tool to run the script in a detached background process using standard shell syntax (e.g., `nohup ... &`):
   `nohup scripts/wait_for_acp_job.py --session-key <childSessionKey> --notify --update-ledger > /dev/null 2>&1 &`
   This will monitor the job and send a desktop OS notification (via `notify-send`) when the job completes. **This is strictly an OS-level notification and will NOT wake up the Assistant.**
4. **Reply to User:** Yield a message explaining that the job has been started in the background, the execution turn will now end, and an OS notification will appear when it's done. Remind the user they will need to manually reprompt you (e.g., "Check status of the job") to see the final results.

## Unsolved Platform Gaps

- If the terminal/agent is fully closed, background polling (Strategy B) might die depending on OS process management, and no notification will be sent.
- We cannot force the agent to type a message into the chat UI automatically. The user MUST reprompt manually in Strategy B.
