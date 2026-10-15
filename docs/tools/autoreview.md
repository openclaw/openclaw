---
summary: "Run the installed Auto Review checkpoint against the current sandbox"
title: "Auto Review"
read_when:
  - You want Auto Review to review sandboxed repository changes
  - You are enabling the optional autoreview tool
---

`autoreview` is an optional bundled plugin tool for the canonical
[Auto Review skill](https://github.com/openclaw/agent-skills/tree/main/skills/autoreview).
The installed helper captures and rechecks repository changes inside the calling
session's sandbox. The Gateway runs the selected reviewer through restricted
`openclaw agent exec`, then returns the complete output to the same helper for
validation.

## Enable

Enable the `autoreview` plugin and add `autoreview` to the intended agent's tool
policy. If that agent has a sandbox tool allowlist, allow it there too. Existing
deny rules still apply.

```json
{
  "plugins": { "entries": { "autoreview": { "enabled": true } } },
  "tools": { "alsoAllow": ["autoreview"] }
}
```

Install a current canonical Auto Review package through the managed skill
installation or skill library. The sandbox must provide `/usr/bin/python3` and
a protected, read-only copy of that selected package. A repository-local skill
named `autoreview` does not qualify. The tool is unavailable when those bindings
or the calling user's model authority are absent.
The backend must enforce read-only resource mounts; SSH sandbox file uploads do
not qualify. Mounts or tmpfs overlays that replace the selected package also make
it unavailable.
Writable aliases of the package's backing files also disqualify it.

The canonical skill discovers the enabled tool and calls it at its required
checkpoint. If the tool is unavailable, enable the narrow capability or repair
the installation. Do not substitute host shell access or a reviewer child.

## Inputs and results

`model` (an explicit `provider/model`) and `thinking` are required. The model must
remain allowed by the initiating user's policy. `mode`, `base`, `commit`,
`maxPriority`, `passes`, `prompt`, `promptFiles`, `datasets`, `sourceContext`, and
`sourceContextFiles` map to the canonical helper's matching options. File inputs
are relative to the current sandbox repository. `timeoutSeconds` sets each
reviewer pass's wall-clock limit, from 1 to 600 seconds, and defaults to 600.
The operation allows at most eight planned passes; `passes` can lower that cap.
Preparation and validation share one additional pass-sized allowance within the
total deadline. The original session deadline and cancellation still apply.

The operation fixes the helper, engine, interpreter, executable, restricted
configuration, current sandbox working directory, and private exchange paths.
The reviewer gets an empty private workspace and home, no tools, no selected
skills, and no injected workspace context. Provider credentials stay on the host.
No host Git operation substitutes for the sandbox's staged, unstaged, or untracked
state.

The result contains the helper-validated report and status. Findings are a
completed review. A failed, interrupted, oversized, mismatched, or incomplete
execution is an error and never triggers another engine. Stop and model-policy
revocation cancel this operation's processes; concurrent calls own separate
exchanges and results. This integration supports POSIX sandboxes with the
required protected Python helper.

The complete report and status are limited to 8 MiB, below Code Mode's default
10 MiB full-value inbox. Larger results fail with a split-review diagnostic;
findings and preserved provider/pass reports are never silently truncated.
Lower operator-configured Code Mode limits still apply. Direct tool calls must
also fit the initiating model's existing output budget. Larger direct reports
fail explicitly with instructions to use Code Mode or split the review.
