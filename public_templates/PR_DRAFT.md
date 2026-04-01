# PR Draft

## Suggested Title

Add reusable agent workspace template and six-role collaboration starter

## Suggested Summary

This change adds a contribution-safe workspace template for long-running agent sessions.

Included:

- root workspace protocol files
- context and verification rules
- starter memory structure
- a reusable six-role collaboration pattern
- basic triage, researcher, and verifier agent templates

Goals:

- make agent workspaces easier to bootstrap
- separate public protocol from private runtime state
- provide a reusable collaboration pattern without leaking user-specific content

## Review Notes

- templates are generic and contain no personal memory
- live workspace files are not part of this contribution set
- private data and runtime artifacts are excluded by design
