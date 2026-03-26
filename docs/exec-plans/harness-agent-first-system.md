---
summary: "Next-stage plan for moving OpenClaw from harness core to a broader agent-first engineering system"
read_when:
  - You are planning the next stage after the core harness roadmap
  - You need the post-roadmap plan derived from the Harness Engineering checklist
owner: "OpenClaw harness"
freshness: "monthly"
last_reviewed: "2026-03-25"
title: "Harness Agent-First System Plan"
---

# Harness Agent-First System Plan

## Goal

Move OpenClaw from a completed harness control plane toward a broader agent-first engineering system.

## Current baseline

OpenClaw now has:

- task profiles
- workspace policy discovery and slicing
- prompt budget reporting
- verify / failure / retry loops
- tool and skill pruning
- delegation profile
- failure-to-rule suggestions
- cron health-check installation flow

## Next milestones

### M1. Mechanical repo constraints

- add doc/policy lint for ownership, freshness, and broken links
- add structural lint for directory boundaries and import direction
- add error/remediation and naming conventions that can be mechanically checked

### M2. Long-term governance

- add a workspace health dashboard
- aggregate prompt budget, retry, and failure trends
- add periodic doc-gardening and cleanup automation

### M3. Wider execution environment visibility

- expose browser and UI state to agent runs
- expose logs, metrics, and traces through agent-friendly query surfaces
- evaluate review -> reverify -> merge automation

## Exit signal

OpenClaw stops being only a strong harness runtime and starts behaving like a broader agent-first engineering operating layer.
