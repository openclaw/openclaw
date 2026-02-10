---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Exec approvals, allowlists, and sandbox escape prompts"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Configuring exec approvals or allowlists（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Implementing exec approval UX in the macOS app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Reviewing sandbox escape prompts and implications（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Exec Approvals"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Exec approvals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Exec approvals are the **companion app / node host guardrail** for letting a sandboxed agent run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
commands on a real host (`gateway` or `node`). Think of it like a safety interlock:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
commands are allowed only when policy + allowlist + (optional) user approval all agree.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Exec approvals are **in addition** to tool policy and elevated gating (unless elevated is set to `full`, which skips approvals).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Effective policy is the **stricter** of `tools.exec.*` and approvals defaults; if an approvals field is omitted, the `tools.exec` value is used.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the companion app UI is **not available**, any request that requires a prompt is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
resolved by the **ask fallback** (default: deny).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Where it applies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Exec approvals are enforced locally on the execution host:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **gateway host** → `openclaw` process on the gateway machine（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **node host** → node runner (macOS companion app or headless node host)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
macOS split:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **node host service** forwards `system.run` to the **macOS app** over local IPC.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **macOS app** enforces approvals + executes the command in UI context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Settings and storage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Approvals live in a local JSON file on the execution host:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`~/.openclaw/exec-approvals.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example schema:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "version": 1,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "socket": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "path": "~/.openclaw/exec-approvals.sock",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "token": "base64url-token"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "defaults": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "security": "deny",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "ask": "on-miss",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "askFallback": "deny",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "autoAllowSkills": false（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "main": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "security": "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "ask": "on-miss",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "askFallback": "deny",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "autoAllowSkills": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "allowlist": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "id": "B0C8C0B3-2C2D-4F8A-9A3C-5A4B3C2D1E0F",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "pattern": "~/Projects/**/bin/rg",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "lastUsedAt": 1737150000000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "lastUsedCommand": "rg -n TODO",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Policy knobs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Security (`exec.security`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **deny**: block all host exec requests.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **allowlist**: allow only allowlisted commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **full**: allow everything (equivalent to elevated).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Ask (`exec.ask`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **off**: never prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **on-miss**: prompt only when allowlist does not match.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **always**: prompt on every command.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Ask fallback (`askFallback`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If a prompt is required but no UI is reachable, fallback decides:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **deny**: block.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **allowlist**: allow only if allowlist matches.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **full**: allow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Allowlist (per agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Allowlists are **per agent**. If multiple agents exist, switch which agent you’re（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
editing in the macOS app. Patterns are **case-insensitive glob matches**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Patterns should resolve to **binary paths** (basename-only entries are ignored).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Legacy `agents.default` entries are migrated to `agents.main` on load.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/Projects/**/bin/peekaboo`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.local/bin/*`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/opt/homebrew/bin/rg`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each allowlist entry tracks:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **id** stable UUID used for UI identity (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **last used** timestamp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **last used command**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **last resolved path**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Auto-allow skill CLIs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When **Auto-allow skill CLIs** is enabled, executables referenced by known skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
are treated as allowlisted on nodes (macOS node or headless node host). This uses（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`skills.bins` over the Gateway RPC to fetch the skill bin list. Disable this if you want strict manual allowlists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Safe bins (stdin-only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`tools.exec.safeBins` defines a small list of **stdin-only** binaries (for example `jq`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
that can run in allowlist mode **without** explicit allowlist entries. Safe bins reject（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
positional file args and path-like tokens, so they can only operate on the incoming stream.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Shell chaining and redirections are not auto-allowed in allowlist mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Shell chaining (`&&`, `||`, `;`) is allowed when every top-level segment satisfies the allowlist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(including safe bins or skill auto-allow). Redirections remain unsupported in allowlist mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Command substitution (`$()` / backticks) is rejected during allowlist parsing, including inside（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
double quotes; use single quotes if you need literal `$()` text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default safe bins: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Control UI editing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the **Control UI → Nodes → Exec approvals** card to edit defaults, per‑agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
overrides, and allowlists. Pick a scope (Defaults or an agent), tweak the policy,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
add/remove allowlist patterns, then **Save**. The UI shows **last used** metadata（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
per pattern so you can keep the list tidy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The target selector chooses **Gateway** (local approvals) or a **Node**. Nodes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
must advertise `system.execApprovals.get/set` (macOS app or headless node host).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If a node does not advertise exec approvals yet, edit its local（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`~/.openclaw/exec-approvals.json` directly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CLI: `openclaw approvals` supports gateway or node editing (see [Approvals CLI](/cli/approvals)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Approval flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a prompt is required, the gateway broadcasts `exec.approval.requested` to operator clients.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Control UI and macOS app resolve it via `exec.approval.resolve`, then the gateway forwards the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
approved request to the node host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When approvals are required, the exec tool returns immediately with an approval id. Use that id to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
correlate later system events (`Exec finished` / `Exec denied`). If no decision arrives before the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
timeout, the request is treated as an approval timeout and surfaced as a denial reason.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The confirmation dialog includes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- command + args（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- cwd（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- agent id（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- resolved executable path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- host + policy metadata（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Actions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Allow once** → run now（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Always allow** → add to allowlist + run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Deny** → block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Approval forwarding to chat channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can forward exec approval prompts to any chat channel (including plugin channels) and approve（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
them with `/approve`. This uses the normal outbound delivery pipeline.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  approvals: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    exec: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mode: "session", // "session" | "targets" | "both"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      agentFilter: ["main"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sessionFilter: ["discord"], // substring or regex（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      targets: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        { channel: "slack", to: "U12345678" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        { channel: "telegram", to: "123456789" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Reply in chat:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/approve <id> allow-once（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/approve <id> allow-always（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/approve <id> deny（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### macOS IPC flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway -> Node Service (WS)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                 |  IPC (UDS + token + HMAC + TTL)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                 v（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
             Mac App (UI + approvals + system.run)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Security notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unix socket mode `0600`, token stored in `exec-approvals.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Same-UID peer check.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Challenge/response (nonce + HMAC token + request hash) + short TTL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## System events（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Exec lifecycle is surfaced as system messages:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Exec running` (only if the command exceeds the running notice threshold)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Exec finished`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Exec denied`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These are posted to the agent’s session after the node reports the event.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway-host exec approvals emit the same lifecycle events when the command finishes (and optionally when running longer than the threshold).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Approval-gated execs reuse the approval id as the `runId` in these messages for easy correlation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Implications（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **full** is powerful; prefer allowlists when possible.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **ask** keeps you in the loop while still allowing fast approvals.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Per-agent allowlists prevent one agent’s approvals from leaking into others.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Approvals only apply to host exec requests from **authorized senders**. Unauthorized senders cannot issue `/exec`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/exec security=full` is a session-level convenience for authorized operators and skips approvals by design.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  To hard-block host exec, set approvals security to `deny` or deny the `exec` tool via tool policy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Exec tool](/tools/exec)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Elevated mode](/tools/elevated)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Skills](/tools/skills)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
