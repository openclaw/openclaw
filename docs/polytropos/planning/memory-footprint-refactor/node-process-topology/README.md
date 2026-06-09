# Node Process Topology

This folder collects working notes about the Node.js runtime/process topology in
OpenClaw/Polytropos, with a bias toward memory analysis and process-count
reduction.

## Current contents

- `process-inventory.md`
  First-pass inventory of OpenClaw-owned Node.js process families, their
  responsibilities, how they communicate, and when they are created.

## Intended follow-ons

- measured RSS/heap baseline per process family
- startup-path timeline for the default gateway deployment
- candidate consolidation plan
- gateway-leak-specific notes once process topology is stable
