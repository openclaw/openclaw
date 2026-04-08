---
title: "Exec Approval Limitations"
summary: "Explains behavior of exec approvals with parameterized commands and interpreter bindings"
read_when:
  - "Understanding exec approval behavior"
  - "Working with dynamic commands"
---

# Exec Approval Limitations

## Problem

Exec approvals are typically based on executable path allowlisting. This means that once a specific executable (for example, Python) is approved, it should ideally not require repeated approvals.

However, when commands are parameterized—such as running the same script with different arguments—the system may treat each variation as a new command. As a result, even though the executable path remains the same, users may still encounter repeated approval prompts.

## Example

```bash
python email_sender.py --content-file Day_007.md
python email_sender.py --content-file Day_008.md
```