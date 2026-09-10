---
summary: "Install the acpx ACP runtime plugin, confirm it is usable, and pick a harness target id"
title: "ACP agents quickstart"
read_when:
  - You are installing or enabling the ACP runtime plugin
  - You need the first-run gotchas and runtime prerequisites
  - You need the supported harness target ids for /acp spawn
---

## Does this work out of the box?

Yes, after installing the official ACP runtime plugin:

```bash
openclaw plugins install @openclaw/acpx
openclaw config set plugins.entries.acpx.enabled true
```

Source checkouts can use the local `extensions/acpx` workspace plugin after
`pnpm install`. Run `/acp doctor` for a readiness check.

OpenClaw only teaches agents about ACP spawning when ACP is **truly usable**:
ACP must be enabled, dispatch must not be disabled, the current session must
not be sandbox-blocked, and a runtime backend must be loaded and healthy. If
any condition fails, ACP skills and `sessions_spawn` ACP guidance stay hidden
so the agent does not suggest an unavailable backend.

<AccordionGroup>
  <Accordion title="First-run gotchas">
    - If `plugins.allow` is set, it is a restrictive plugin inventory and **must** include `acpx`, or the installed ACP backend is intentionally blocked (`/acp doctor` reports the missing allowlist entry).
    - The Codex ACP adapter ships with the `acpx` plugin and launches locally when possible.
    - Codex ACP runs with an isolated `CODEX_HOME`. OpenClaw copies trusted project trust entries plus safe model/provider routing config (`model`, `model_provider`, `model_reasoning_effort`, `sandbox_mode`, and safe `model_providers.<name>` fields) from the host Codex config; auth, notifications, and hooks stay on the host config only.
    - Other target harness adapters may be fetched on demand with `npx` on first use.
    - Vendor auth must already exist on the host for that harness.
    - If the host has no npm or network access, first-run adapter fetches fail until caches are pre-warmed or the adapter is installed another way.

  </Accordion>
  <Accordion title="Runtime prerequisites">
    ACP launches a real external harness process. OpenClaw owns routing,
    background-task state, delivery, bindings, and policy; the harness owns
    its provider login, model catalog, filesystem behavior, and native tools.

    Before blaming OpenClaw, verify:

    - `/acp doctor` reports an enabled, healthy backend.
    - The target id is allowed by `acp.allowedAgents` when that allowlist is set.
    - The harness command can start on the Gateway host.
    - Provider auth is present for that harness (`claude`, `codex`, `gemini`, `opencode`, `droid`, etc.).
    - The selected model exists for that harness - model ids are not portable across harnesses.
    - The requested `cwd` exists and is accessible, or omit `cwd` and let the backend use its default.
    - Permission mode matches the work. Non-interactive sessions cannot click native permission prompts, so write/exec-heavy coding runs usually need an ACPX permission profile that can proceed headlessly.

  </Accordion>
</AccordionGroup>

OpenClaw plugin tools and built-in OpenClaw tools are **not** exposed to ACP
harnesses by default. Enable the explicit MCP bridges in
[ACP agents - setup](/tools/acp-agents-setup) only when the harness should
call those tools directly.

## Supported harness targets

With the `acpx` backend, use these ids as `/acp spawn <id>` or
`sessions_spawn({ runtime: "acp", agentId: "<id>" })` targets:

| Harness id   | Typical backend                                | Notes                                                                               |
| ------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `claude`     | Claude Code ACP adapter                        | Requires Claude Code auth on the host.                                              |
| `codex`      | Codex ACP adapter                              | Explicit ACP fallback only when native `/codex` is unavailable or ACP is requested. |
| `copilot`    | GitHub Copilot ACP adapter                     | Requires Copilot CLI/runtime auth.                                                  |
| `cursor`     | Cursor CLI ACP (`cursor-agent acp`)            | Override the acpx command if a local install exposes a different ACP entrypoint.    |
| `droid`      | Factory Droid CLI                              | Requires Factory/Droid auth or `FACTORY_API_KEY` in the harness environment.        |
| `fast-agent` | fast-agent-mcp ACP adapter                     | Fetched on demand with `uvx`.                                                       |
| `gemini`     | Gemini CLI ACP adapter                         | Requires Gemini CLI auth or API key setup.                                          |
| `iflow`      | iFlow CLI                                      | Adapter availability and model control depend on the installed CLI.                 |
| `kilocode`   | Kilo Code CLI                                  | Adapter availability and model control depend on the installed CLI.                 |
| `kimi`       | Kimi/Moonshot CLI                              | Requires Kimi/Moonshot auth on the host.                                            |
| `kiro`       | Kiro CLI                                       | Adapter availability and model control depend on the installed CLI.                 |
| `mux`        | Mux CLI ACP adapter                            | Fetched on demand with `npx`.                                                       |
| `opencode`   | OpenCode ACP adapter                           | Requires OpenCode CLI/provider auth.                                                |
| `openclaw`   | OpenClaw Gateway bridge through `openclaw acp` | Lets an ACP-aware harness talk back to an OpenClaw Gateway session.                 |
| `qoder`      | Qoder CLI                                      | Adapter availability and model control depend on the installed CLI.                 |
| `qwen`       | Qwen Code / Qwen CLI                           | Requires Qwen-compatible auth on the host.                                          |
| `trae`       | Trae CLI ACP adapter                           | Adapter availability and model control depend on the installed CLI.                 |

`pi` (pi-acp) is also registered in the acpx backend but is not a coding
harness in the same sense as the others above.

Custom acpx agent aliases can be configured in acpx itself, but OpenClaw
policy still checks `acp.allowedAgents` and any
`agents.entries.*.runtime.acp.agent` mapping before dispatch.
