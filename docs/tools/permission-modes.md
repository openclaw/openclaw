---
summary: "Permission modes for host exec, Codex Guardian approvals, and ACPX harness sessions"
read_when:
  - Choosing auto, ask, allowlist, full, or deny for command permissions
  - Configuring Codex Guardian-reviewed approvals through tools.exec.mode
  - Comparing OpenClaw exec approvals with ACPX harness permissions
title: "Permission modes"
---

Permission modes decide how much authority an agent has before it runs host commands, writes files, or asks a backend harness for extra access.

<Note>
  Permission mode is separate from `tools.exec.host=auto`. `tools.exec.host`
  chooses where a command runs. `tools.exec.mode` chooses how host exec is
  approved.
</Note>

## Recommended default

Use `auto` for coding agents that need useful host access without making every miss a human prompt:

```bash
openclaw config set tools.exec.mode auto
openclaw approvals get
openclaw gateway restart
```

Then verify the effective policy:

```bash
openclaw exec-policy show
```

## OpenClaw host exec modes

`tools.exec.mode` is the normalized policy surface for host `exec`. Each mode resolves to an underlying `security` (allowlist strictness) and `ask` (prompt-on-miss) pair:

| Mode        | security / ask          | Behavior                                                                      | Use when                                               |
| ----------- | ----------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| `deny`      | `deny` / `off`          | Block host exec entirely.                                                     | No host commands are allowed.                          |
| `allowlist` | `allowlist` / `off`     | Run only allowlisted commands; silently deny misses.                          | You have a known-safe command set.                     |
| `ask`       | `allowlist` / `on-miss` | Run allowlist matches; ask a human on misses.                                 | A human should review every new command.               |
| `auto`      | `allowlist` / `on-miss` | Run allowlist matches; review eligible misses with `allow`, `deny`, or `ask`. | Coding sessions need practical guarded access.         |
| `full`      | `full` / `off`          | Run host exec without ordinary policy prompts.                                | This trusted host should skip ordinary policy prompts. |

`ask` and `auto` share the same allowlist/ask settings; `auto` additionally enables the native auto-reviewer. An `allow` verdict permits one low- or medium-risk execution. A `deny` verdict returns a reason to the agent so it can choose a materially safer alternative or ask the user. An `ask` verdict requests human approval, as do review failures. On the gateway, three consecutive reviewer denials escalate to a human. Existing binding checks and explicit human-approval requirements still apply; see [Exec modes](/tools/exec#modes).

Gateway approval-backed commands bind every resolved command-segment executable before review and re-check it before launch: protected executables use resolved real-path identity only, while writable executables also use a content hash. Node identity checks cover local policy evaluation through dispatch, with a [remote shell-wrapper approval limitation](/tools/exec-approvals-advanced#interpreter%2Fruntime-commands). In `auto` mode, POSIX login or interactive shell wrappers skip the reviewer and require human approval when binding succeeds; existing binding rejections remain denied. Their implicit startup files are outside operand binding.

[`tools.exec.strictInlineEval`](/tools/exec#inline-eval-strictinlineeval) is a separate opt-in setting and defaults to `false`. When ordinary host approval evaluation runs, recognized inline-eval forms such as `python -c`, `node -e`, and `sed` programs require reviewer or explicit approval when strict mode is enabled, even under `full`/`off` policy. Configured `tools.exec.mode: "full"` alone does not bypass that check.

Gateway execution from a full-permission session with effective security `full` and ask `off`, or from permitted elevated-full execution with both exec and host approval policies allowing `full`/`off`, skips the host approval path and its strict-inline detector. Ask-only tightening of a full session restores that path. See [Session permission modes](/gateway/permission-modes) and [Elevated mode](/tools/elevated).

For the full host exec policy, local approvals file, allowlist schema, safe bins, and forwarding behavior, see [Exec approvals](/tools/exec-approvals).

## Codex Guardian mapping

For native Codex app-server sessions, `tools.exec.mode: "auto"` drives Codex toward Guardian-reviewed approvals when the local Codex requirements allow it. Typical resulting values:

| Codex field         | Typical value     |
| ------------------- | ----------------- |
| `approvalPolicy`    | `on-request`      |
| `approvalsReviewer` | `auto_review`     |
| `sandbox`           | `workspace-write` |

`auto` mode forces this policy over any configured Codex sandbox/approval overrides, so it does not preserve legacy unsafe combinations such as `approvalPolicy: "never"` with `sandbox: "danger-full-access"`. `tools.exec.mode: "deny"` and `"allowlist"` block Codex app-server local execution entirely. Use `tools.exec.mode: "full"` only when you intentionally want the no-approval posture.

For app-server setup, auth order, and native Codex runtime details, see [Codex harness](/plugins/codex-harness).

## ACPX harness permissions

ACPX sessions have no interactive TTY for permission prompts. Supported ACP
form and URL requests can still reach the operator as Gateway questions during
a channel-delivered turn; those are separate from permission approval. ACPX
uses separate harness-level settings under `plugins.entries.acpx.config`:

| Setting                     | Values          | Meaning                                     |
| --------------------------- | --------------- | ------------------------------------------- |
| `permissionMode`            | `approve-reads` | Auto-approve reads only.                    |
| `permissionMode`            | `approve-all`   | Auto-approve writes and shell commands.     |
| `permissionMode`            | `deny-all`      | Deny all permission prompts.                |
| `nonInteractivePermissions` | `fail`          | Abort when a prompt would be required.      |
| `nonInteractivePermissions` | `deny`          | Deny the prompt and continue when possible. |

Set ACPX permissions separately from OpenClaw exec approvals:

```bash
openclaw config set plugins.entries.acpx.config.permissionMode approve-all
openclaw config set plugins.entries.acpx.config.nonInteractivePermissions fail
openclaw gateway restart
```

Use `approve-all` as the ACPX break-glass equivalent of a no-prompt harness session. For setup details and failure modes, see [ACP agents setup](/tools/acp-agents-setup#permission-configuration).

## Choosing a mode

| Goal                                          | Configure                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Block host commands completely                | `tools.exec.mode: "deny"`                                                              |
| Let known-safe commands run only              | `tools.exec.mode: "allowlist"`                                                         |
| Ask a human for every new command shape       | `tools.exec.mode: "ask"`                                                               |
| Use Codex/OpenClaw auto-review before humans  | `tools.exec.mode: "auto"`                                                              |
| Skip ordinary host exec approval prompts      | `tools.exec.mode: "full"` plus matching host approvals, with `strictInlineEval: false` |
| Make non-interactive ACPX sessions write/exec | `plugins.entries.acpx.config.permissionMode: "approve-all"`                            |

If a command still prompts or fails after changing mode, inspect both layers:

```bash
openclaw approvals get
openclaw exec-policy show
```

Outside the full-permission Gateway session exception described above, host exec uses the stricter result of OpenClaw config and the host-local approvals file. ACPX harness permissions do not loosen host exec approvals, and host exec approvals do not loosen ACPX harness prompts.

## Related

- [Exec approvals](/tools/exec-approvals)
- [Exec approvals - advanced](/tools/exec-approvals-advanced)
- [Codex harness](/plugins/codex-harness)
- [ACP agents setup](/tools/acp-agents-setup#permission-configuration)
