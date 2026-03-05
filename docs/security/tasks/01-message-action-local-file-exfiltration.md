---
summary: "Prevent message action inputs from reading arbitrary local files"
title: "Task 01: Message Action Local File Exfiltration Guard"
---

## Objective

Close the path where message actions can be abused to exfiltrate arbitrary local files.

## Scope

- Message action parsing and execution path.
- Any helper that resolves `file://` URIs or local paths from user-controlled input.
- Related audit logging and error handling.

## Task Checklist

- [ ] Inventory all message action inputs that can reference local paths.
- [ ] Canonicalize and validate paths before access (`realpath`, traversal checks, symlink handling).
- [ ] Restrict reads to explicitly allowed directories and deny absolute paths outside policy.
- [ ] Block or gate `file://` usage from untrusted contexts.
- [ ] Return safe user-facing errors without leaking filesystem details.
- [ ] Add structured security logs for denied attempts.
- [ ] Document the allowed path policy and operator controls.

## Acceptance Criteria

- Untrusted message actions cannot read arbitrary host files.
- Traversal and symlink escape attempts are denied.
- Authorized safe-path use cases still work.
- Logs show blocked attempts with enough context for incident triage.

## Verification

- Unit tests for traversal, symlink, absolute path, and `file://` cases.
- Integration test proving blocked read for a sensitive file outside allowed directories.
- Regression test for valid in-policy file access.
