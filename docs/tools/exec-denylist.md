---
summary: "Configure exec denylist rules that block matching shell commands before approvals or allowlists can allow them."
read_when:
  - Configuring exec denylist rules
  - Blocking curl, wget, or other commands from the exec tool
  - Choosing between exec denylist, allowlist, and network filtering
title: "Exec denylist"
sidebarTitle: "Exec denylist"
---

The exec denylist is a host exec policy mode for operators who want most shell
commands to run, but want specific command families or command payloads to be
blocked every time. A denylist match denies the command before approval prompts,
allowlist matches, safe-bin matches, durable `allow-always` trust, or process
spawn. The exact managed default `curl`/`wget` rule is a compatibility
exception in `allowlist` mode; custom, edited, or operator-added denylist rules
still win over allowlist trust.

Use denylist rules for small, explicit "never run this through exec" cases. Do
not use the exec denylist as a general URL firewall or adblock engine.

## Quickstart

Set both the requested exec policy and the host approvals policy to `denylist`:

```bash
openclaw config set tools.exec.security denylist
openclaw config set tools.exec.ask off

openclaw approvals set --stdin <<'EOF'
{
  version: 1,
  defaults: {
    security: "denylist",
    ask: "off",
    askFallback: "deny"
  },
  agents: {
    "*": {
      denylist: [
        {
          id: "default-shell-network-fetch",
          pattern: "(?:^|[\\s;&|()<>])(?:curl|wget)(?:\\.exe)?(?:$|[\\s;&|()<>$])|[\\\\/](?:curl|wget)(?:\\.exe)?(?:$|[\\s;&|()<>$])",
          flags: "i"
        }
      ]
    }
  }
}
EOF
```

Then verify the effective policy:

```bash
openclaw approvals get
openclaw exec-policy show
```

For gateway or node hosts, target the approvals file on the host that will run
the command:

```bash
openclaw approvals get --gateway
openclaw approvals get --node <node-id-or-name>
```

## Configure in the Control UI

Open **Control UI -> Nodes -> Exec approvals**.

1. Select **Gateway** or a node target.
2. Load approvals if the card is not loaded.
3. Select the `*` scope to edit rules shared by all agents, or select a
   specific agent scope.
4. Set **Security** to **Denylist**.
5. Add, edit, or remove rules in the **Denylist** section.
6. Save.

The **Defaults** scope only edits policy defaults such as `security`, `ask`,
`askFallback`, and `autoAllowSkills`. Shared denylist rules live under the `*`
agent scope.

## Where rules live

Exec approvals are stored on the execution host:

```text
~/.openclaw/exec-approvals.json
```

The file has policy defaults and per-agent rule scopes:

```json
{
  "version": 1,
  "defaults": {
    "security": "denylist",
    "ask": "off",
    "askFallback": "deny"
  },
  "agents": {
    "*": {
      "denylist": [
        {
          "id": "block-python-eval",
          "pattern": "(?:^|[\\s;&|()<>])python3?\\s+-c(?:$|[\\s;&|()<>])"
        }
      ]
    },
    "main": {
      "denylist": [
        {
          "id": "block-custom-domain",
          "pattern": "https?://(?:[^/\\s]+\\.)?example\\.invalid(?:[/:?\\s]|$)",
          "flags": "i"
        }
      ]
    }
  }
}
```

OpenClaw evaluates wildcard `agents["*"].denylist` entries before the selected
agent's own entries. Denylist entries always win over allowlist and
`allow-always` entries.

## Default curl and wget rule

New approvals files receive a normal wildcard denylist rule for `curl` and
`wget`:

```json
{
  "id": "default-shell-network-fetch",
  "pattern": "(?:^|[\\s;&|()<>])(?:curl|wget)(?:\\.exe)?(?:$|[\\s;&|()<>$])|[\\\\/](?:curl|wget)(?:\\.exe)?(?:$|[\\s;&|()<>$])",
  "flags": "i"
}
```

This managed rule is enforced in denylist mode and when `askFallback` uses
denylist mode. It is skipped while the effective security mode is `allowlist` so
existing allowlist/ask workflows do not start hard-denying shell fetch commands
only because OpenClaw seeded a default. Edit the rule, or add your own
`curl`/`wget` denylist rule, if your allowlist deployment should also block
those commands.

Outside of that exact managed default, denylist entries are normal rule entries
under `agents["*"].denylist`, so a human operator can edit or remove them.

OpenClaw records that it has applied built-in defaults with:

```json
{
  "managedDefaults": {
    "denylistVersion": 1
  }
}
```

When an existing approvals file is normalized during upgrade, OpenClaw records
the same marker but does not add the default curl/wget rule. This preserves
operator-edited approval files. Add the wildcard rule manually if you want an
upgraded file to block curl/wget, or remove it from new files if your deployment
intentionally permits those tools.

After the marker exists, OpenClaw does not re-add the default curl/wget rule if
you delete it.

## Rule format

A denylist entry can be an object:

```json
{
  "id": "block-inline-node-eval",
  "pattern": "(?:^|[\\s;&|()<>])node\\s+(?:-e|--eval)(?:$|[\\s;&|()<>])",
  "flags": "i"
}
```

Legacy string entries are also accepted:

```json
"(?:^|[\\s;&|()<>])node\\s+(?:-e|--eval)(?:$|[\\s;&|()<>])"
```

Object entries are recommended because `id` makes the rule easier to identify
in the Control UI and logs.

Allowed regex flags:

- `i`
- `m`
- `u`

Unsupported flags, empty patterns, unsafe regexes, too many rules, or oversized
inputs fail closed: exec is denied and the error is logged.

## What gets matched

OpenClaw evaluates denylist rules against cheap command candidates, including:

- raw command text
- parsed argv and command segments
- resolved executable path candidates
- selected inline command payload candidates, such as `bash -c "..."` or
  interpreter eval payloads
- environment variable values referenced by the exec command

Rules are regular expressions, not shell globs. Prefer command-token patterns
over broad whole-command patterns.

Good:

```regex
(?:^|[\s;&|()<>])(?:curl|wget)(?:\.exe)?(?:$|[\s;&|()<>$])
```

Too broad:

```regex
curl
```

The broad pattern can match unrelated text, filenames, comments, or URLs that
contain the same letters.

## Denylist and approvals

Denylist matching has no approval escalation path. A matching command is denied
and the agent must choose another tool or another approach.

Precedence:

1. `security: "deny"` blocks all host exec.
2. Denylist matches block the command.
3. `security: "allowlist"` requires allowlist or safe-bin satisfaction.
4. Approval prompts run only when policy still allows prompting.
5. `security: "full"` allows host exec unless a configured fallback path first
   evaluates denylist rules.

When `askFallback` is `denylist`, OpenClaw allows a headless fallback only after
the denylist has already been evaluated for that command.

## Logging

By default, denylist denials are logged without printing the raw command or the
raw regex. Logs include a command hash, command length, host, agent when known,
and the matched rule index when available.

Disable denylist decision logging only if you have another audit path:

```bash
openclaw config set tools.exec.logDenylistDenials false
```

The default is `true`.

## URL and blocklist rules

The exec denylist is not an EasyList-compatible URL filter. EasyList syntax such
as `||example.com^` does not carry its adblock semantics inside exec denylist
rules.

If you need a few URL-oriented exec blocks, translate them into explicit regex
patterns that match command text:

```json
{
  "id": "block-paste-sites",
  "pattern": "https?://(?:[^/\\s]+\\.)?(pastebin\\.com|gist\\.githubusercontent\\.com)(?:[/:?\\s]|$)",
  "flags": "i"
}
```

Avoid pasting large adblock lists into `denylist`. Large general-purpose URL
lists are expensive, noisy, and semantically mismatched with shell command
matching. For broad URL or network policy, use a network proxy or fetch guard
instead of exec denylist rules.

See [network proxy security](/security/network-proxy) for operator-managed
network filtering.

## Troubleshooting

### The denylist looks empty

Check the `*` agent scope, not only **Defaults**. Shared rules live in
`agents["*"].denylist`.

From the CLI:

```bash
openclaw approvals get --json
```

Look for:

```json
{
  "agents": {
    "*": {
      "denylist": []
    }
  }
}
```

### A deleted default rule should not come back

OpenClaw records seeded defaults with:

```json
{
  "managedDefaults": {
    "denylistVersion": 1
  }
}
```

New approvals files include that marker. Existing approvals files that are
normalized during upgrade also receive the marker, but OpenClaw does not add the
default curl/wget rule to them. After the marker exists, OpenClaw treats
operator edits as authoritative and does not recreate a deleted default rule.

### A command was denied but the rule is not obvious

The denial message intentionally does not print the rule text. Check the
denylist entries in order. Logs include `ruleIndex=<number>` when OpenClaw can
identify the matching rule.

### A regex rule makes all exec fail

Invalid or unsafe denylist rules fail closed. Remove or fix the rule, then save
the approvals file again. Keep rules short, anchored to shell token boundaries,
and specific to the command or payload you intend to block.

## See also

- [Exec approvals](/tools/exec-approvals)
- [Exec tool](/tools/exec)
- [Advanced exec approvals](/tools/exec-approvals-advanced)
- [Network proxy security](/security/network-proxy)
