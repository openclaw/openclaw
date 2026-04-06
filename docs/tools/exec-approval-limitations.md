---
title: "Exec Approval Limitations"
summary: "Explains behavior of exec approvals with parameterized commands and interpreter bindings"
read_when:
  - Understanding exec approval behavior
  - Working with dynamic commands
---

# Exec Approval Limitations

## Problem

Exec approvals in OpenClaw are based on executable path allowlisting and interpreter/file binding semantics.

However, when using parameterized commands (e.g., Python scripts with different arguments), previously approved executions may not always be reused as expected.

Example:

```bash
python email_sender.py --content-file Day_007.md
python email_sender.py --content-file Day_008.md
```
