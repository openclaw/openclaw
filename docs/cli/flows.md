---
summary: "Redirect: flow commands live under `mullusi tasks flow`"
read_when:
  - You encounter mullusi flows in older docs or release notes
title: "flows (redirect)"
---

# `mullusi tasks flow`

Flow commands are subcommands of `mullusi tasks`, not a standalone `flows` command.

```bash
mullusi tasks flow list [--json]
mullusi tasks flow show <lookup>
mullusi tasks flow cancel <lookup>
```

For full documentation see [Task Flow](/automation/taskflow) and the [tasks CLI reference](/cli/index#tasks).
