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

python email_sender.py --content-file Day_007.md
python email_sender.py --content-file Day_008.md

Even though the same script is executed, approvals may not carry over due to argument and file-binding behavior.

## Impact

- Repeated approval prompts in dynamic workflows
- Reduced usability when working with parameterized commands

## Suggested Improvements

- Improve reuse of approvals for similar interpreter-based commands
- Provide clearer UX around what is being approved
- Enhance documentation around file-binding and argv semantics

## Related Issue

- #61667