# Migration Guide: Existing Agent → Agent Package

## Quick Start

1. Create `agent-package.json` in your agent directory
2. Run `openclaw-agent pack .` to generate integrity manifest
3. Run `openclaw-agent validate .` to verify
4. Run `openclaw-agent enable . --workspace ~/.openclaw/workspace` to install

## Upgrading

When updating: re-pack, re-enable. The declarative upgrade system computes
field-level diffs and applies changes per the `onUpgrade` policy.
