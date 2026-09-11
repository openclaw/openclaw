---
summary: "Use `scopes.<scopeName>` to hold specific agents or channels to stricter policy than the baseline"
read_when:
  - Some agents or channels need stricter policy than the top-level baseline
  - You want to know which sections accept an `agentIds` or `channelIds` selector
  - A scoped container posture rule reports unobservable evidence
title: "Scoped policy overlays"
sidebarTitle: "Scoped overlays"
---

Holding named agents or channels to stricter rules than the baseline. Part of the [`openclaw policy`](/cli/policy) reference.

## Scoped overlays

Use `scopes.<scopeName>` when specific agents or channels need stricter policy
than the top-level baseline. The scope name is just a label; matching uses the
selector inside the scope. Overlays are additive: the global rule still runs,
and the scoped rule can add its own finding against the same evidence.

| Selector     | Supported sections                                                             | Use when                                          |
| ------------ | ------------------------------------------------------------------------------ | ------------------------------------------------- |
| `agentIds`   | `tools`, `agents.workspace`, `sandbox`, `dataHandling.memory`, `execApprovals` | One or more runtime agents need stricter rules.   |
| `channelIds` | `ingress.channels`                                                             | One or more channels need stricter ingress rules. |

If an `agentIds` entry is not present in `agents.entries.*`, OpenClaw evaluates
the scoped rule against inherited global/default posture for that runtime
agent id instead of skipping it.

```jsonc
{
  "tools": {
    "exec": {
      "allowHosts": ["sandbox", "node"],
    },
  },
  "sandbox": {
    "requireMode": ["all", "non-main"],
  },
  "scopes": {
    "release-workspace": {
      "agentIds": ["release-agent", "review-agent"],
      "agents": {
        "workspace": {
          "allowedAccess": ["none", "ro"],
        },
      },
    },
    "release-lockdown": {
      "agentIds": ["release-agent"],
      "tools": {
        "exec": {
          "allowHosts": ["sandbox"],
          "allowSecurity": ["deny", "allowlist"],
          "requireAsk": ["always"],
        },
        "denyTools": ["exec", "process", "write", "edit", "apply_patch"],
      },
      "sandbox": {
        "requireMode": ["all"],
        "allowBackends": ["docker"],
      },
      "dataHandling": {
        "memory": {
          "denySessionTranscriptIndexing": true,
        },
      },
    },
    "shell-sandbox": {
      "agentIds": ["shell-agent"],
      "sandbox": {
        "allowBackends": ["openshell"],
        "containers": {
          "requireReadOnlyMounts": false,
        },
      },
    },
    "telegram-ingress": {
      "channelIds": ["telegram"],
      "ingress": {
        "channels": {
          "allowDmPolicies": ["pairing"],
          "denyOpenGroups": true,
          "requireMentionInGroups": true,
        },
      },
    },
  },
}
```

The same agent can appear in multiple scopes if each scope governs a different
field, as above. A repeated scoped field for the same agent must be equally or
more restrictive; a weaker duplicate claim is rejected (allow-lists are
subsets, deny-lists are supersets, required booleans are fixed).

Container posture rules (`sandbox.containers.*`) are checked only against
evidence the matched agent's sandbox backend can expose. The Docker and Podman
backends expose the same `sandbox.docker.*` container posture settings. If a
backend cannot observe a rule you enabled for it, policy reports
`policy/sandbox-container-posture-unobservable` instead of passing; scope
container rules to the agent groups that use a backend which can expose them.

Backend authorization uses the configured identity. `backend: "docker"`
requires `allowBackends: ["docker"]`, while `backend: "podman"` requires
`allowBackends: ["podman"]`.

Top-level `ingress.session.requireDmScope` stays global; `session.dmScope` is
not channel-attributable evidence, so it cannot be scoped by `channelIds`.

Every scope present in `policy.jsonc` must be valid and enforceable.
