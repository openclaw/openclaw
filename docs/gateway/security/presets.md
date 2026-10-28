---
summary: "Coherent personal and corporate defaults for execution, steering, and conversation reach"
read_when:
  - Choosing personal or corporate security defaults
  - Switching sandbox, approval, filesystem, and steering settings together
  - Understanding explicit overrides and preset migration
title: "Security presets"
---

Use `security.preset` to select a coherent set of defaults instead of configuring each security control independently:

```json5
{ security: { preset: "personal" } } // default; use "corporate" for isolation-first defaults
```

**Personal is the default trusted-operator/YOLO posture.** It keeps unsandboxed execution and collaborative steering together. Normal messages are handled automatically; if they cannot steer, they queue quietly without asking the sender to resend them.

**Corporate is an isolation-first starting point, not a compliance guarantee or tenant boundary.** Configure an available sandbox backend before selecting it. A missing sandbox does not authorize falling back to host execution.

## What the presets select

These are defaults for otherwise-unset fields. Explicit global settings, agent overrides, session settings, and mandatory host/role policies still apply.

| Control                               | Personal                                            | Corporate                                        |
| ------------------------------------- | --------------------------------------------------- | ------------------------------------------------ |
| Agent sandbox                         | Off                                                 | All sessions, separate sandbox per session       |
| Sandbox workspace                     | Existing backend defaults                           | Read/write workspace                             |
| Docker/Podman command network         | Not applicable while unsandboxed                    | `none`                                           |
| Exec mode                             | `full`                                              | `ask` for host escalation policy                 |
| Host inline-eval approval hardening   | Off                                                 | On                                               |
| Managed file tools and `apply_patch`  | No preset workspace-only limit                      | Workspace-only                                   |
| Elevated exec                         | Enabled, still requires its existing grants         | Disabled                                         |
| Other participants steering           | Allowed under the active turn's unchanged authority | Disabled                                         |
| Blocked collaborative steer           | Quiet separate turn                                 | Strict refusal                                   |
| Session-tool reach                    | Gateway-wide, subject to access checks              | Current session and its spawn tree               |
| Ordinary cross-agent tool access      | Enabled, subject to access checks                   | Disabled; existing owned-child exceptions remain |
| Cross-conversation message-tool sends | Existing permissive defaults                        | Disabled within and across providers             |
| DM session routing                    | Existing default                                    | Separate account/channel/peer sessions           |

Sandbox networking covers sandboxed commands, not every Gateway-hosted tool, browser, MCP server, plugin, or model request. Other backends retain their own networking controls. Sandbox commands do not gain a new per-command human approval step; ordinary host escalation uses the existing approval engine. See [sandbox coverage](/gateway/sandboxing/what-gets-sandboxed) and [exec modes](/tools/exec#modes).

Presets do not change Gateway authentication, pairing, channel allowlists, operator roles, session members, public shares, credentials, model access, or host approval files. A personal preset is not an admin `full` session permission grant and cannot bypass a stricter host approval policy or required sandbox.

## Precedence and explicit overrides

1. Existing mandatory host, role, access, and approval checks remain authoritative.
2. Normal explicit session/per-turn settings and per-agent overrides keep their existing precedence and clamping rules.
3. Explicit global settings override the preset's defaults.
4. The preset supplies only missing values; the default preset is `personal`.

An explicit legacy `tools.exec.security`/`ask` policy is kept as a whole; the preset does not add a competing `mode`. Arrays such as tool allow/deny lists are not rewritten.

For example, keep the personal execution posture but separate participants' turns:

```json5
{
  security: { preset: "personal" },
  messages: {
    queue: { allowCollaborativeSteering: false, collaborativeSteeringFallback: "queue" },
  },
}
```

That override still works automatically and quietly. `collaborativeSteeringFallback: "reject"` is the explicit opt-in for refusing a blocked steer and requiring a fresh request. Automatic queue fallback does not emit queue-status messages. Genuine rejection, cancellation uncertainty, and queue overflow still have visible outcomes.

You can customize corporate defaults too. Consequently, the name `corporate` alone is not evidence that an execution is sandboxed: inspect its resolved settings and configure mandatory operator-role/host restrictions where enforcement is required. See [session permission precedence](/gateway/permission-modes#policy-precedence-and-clamping).

## Steering authority is execution-bound

With collaboration enabled, Bob's admitted message can influence Alice's running turn, including when Bob has fewer permissions. **The turn keeps Alice's authority.** Bob remains the message author; neither identical request text nor a model explanation securely attributes a later tool call to Bob. A higher-privilege steer likewise does not upgrade a lower-privilege incumbent. Tools that explicitly select an enrolled participant retain their existing requester-selection and authorization contract; that selection is not causal attribution to a message.

With collaboration disabled and quiet queue fallback selected, each sender gets a separate execution with their requester identity and current applicable policy. Distinct senders are not collected merely because both ask "Summarize report.txt". Message-ID deduplication is not semantic deduplication. Compatible messages from one requester may still collect when that mode is selected.

Explicit policy profiles constrain executions, not individual sentences in a blended conversation. Shared history can still influence later turns, and changing a preset cannot retract information the model already saw. Corporate strict steering does not isolate shared conversation history or outputs. Use [separate trust boundaries](/gateway/security/trust-model) for mutually untrusted users.

## Existing installations and changes

- Existing explicit settings, including `allowCollaborativeSteering: false`, remain unchanged. That existing false value now queues quietly unless strict refusal is explicitly selected.
- Otherwise-unset settings resolve from the personal preset. This makes collaborative steering and unrestricted `apply_patch` consistent with the trusted full-access posture; choose corporate or explicit restrictions when that is not intended.
- Config reads do not rewrite your file. Preset expansion stays runtime-only, including after ordinary configuration writes. Switching the preset does not pin the previous preset's derived values into your file.
- Doctor keeps explicit true/false steering choices and no longer persists competing queue defaults. An older explicit value, even one persisted by an earlier Doctor, must be unset if the preset should control it.
- Changing presets uses the existing configuration publication/reload lifecycle for subsequent policy preparation. Already-started effects are not undone, retained work keeps its governing authority, and history is not rewritten.
- Corporate DM isolation changes the routing key for subsequent messages. Old sessions and history remain stored; they are not copied into the new peer-specific conversations or deleted.

## Comparison with other agent products

Primary documentation and Codex source inspected on October 27, 2026. This is a design comparison, not a runtime security certification. "YOLO" does not mean the same thing across products, and approval suppression is not isolation.

| Product                                                                                 | Relevant design                                                                                                                                                                                                                                                                                                      | Lesson for OpenClaw                                                                                     |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [Claude Code](https://code.claude.com/docs/en/permissions)                              | Permission modes and the [Bash sandbox](https://code.claude.com/docs/en/sandboxing) are independent; managed policy and explicit deny rules remain distinct controls.                                                                                                                                                | Bundle a useful posture without erasing stronger policy. Do not claim Bash isolation covers every tool. |
| [Codex](https://learn.chatgpt.com/docs/agent-approvals-security)                        | Permission profiles, approval policy, and managed requirements are separate. [Source](https://github.com/openai/codex/blob/8f73cdee456b6c46b791780d40cadf9d556d22a4/codex-rs/utils/cli/src/shared_options.rs) distinguishes automatic workspace review from `--yolo`, which disables prompts and command sandboxing. | Make full access an understandable posture, but keep mandatory requirements independent.                |
| [Copilot CLI](https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-cli) | Automatic tool approval, trusted paths, and local/cloud sandboxes are separate; explicit deny rules override tool allows.                                                                                                                                                                                            | "Allow all tools" must not be presented as a network/filesystem sandbox or as an access grant.          |
| [Cursor](https://cursor.com/docs/agent/security/run-modes)                              | Auto-review combines supported command sandboxing with review; Run Everything removes those checks. Team policies and sandbox configuration are separate layers.                                                                                                                                                     | Present coherent modes while distinguishing safe execution from approval UX.                            |
| [Gemini CLI](https://geminicli.com/docs/reference/policy-engine/)                       | Approval modes and [sandbox backends](https://geminicli.com/docs/cli/sandbox/) are independent; [enterprise controls](https://geminicli.com/docs/admin/enterprise-controls/) can constrain YOLO. Backend network defaults differ.                                                                                    | Do not equate "sandbox enabled" with universal network denial.                                          |
| [OpenCode](https://opencode.ai/docs/en/permissions/)                                    | Per-tool allow/ask/deny policy has permissive defaults and external-directory checks. Auto approval still honors explicit deny; agent policies can override ordinary global settings.                                                                                                                                | Preserve explicit policy and document what a preset fills versus what is enforced.                      |

These references do not establish secure causal attribution of actions after several principals' messages enter one model turn. OpenClaw's execution/requester boundaries must remain explicit rather than relying on a model to infer whose permissions apply.
