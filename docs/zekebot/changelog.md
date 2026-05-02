---
summary: "ZekeBot native changes and upstream decision pointers."
read_when:
  - Reviewing what changed in the ZekeBot fork
  - Finding upstream merge decision records
title: "ZekeBot changelog"
---

# ZekeBot Changelog

This page summarizes ZekeBot-specific platform changes. Upstream OpenClaw release decisions are recorded in the Zeke governance repo at `docs/upstream-merges.md`.

## OCL-FORK-001

- Created the `openzeke/zekebot` fork from OpenClaw.
- Added ZekeBot governance files, license notice, and fork manifest.
- Added GHCR image workflows for the fork image family.
- Added stock-equivalence smoke and manual `:latest` promotion gate.
- Added `/home/node/.openclaw` as an explicit Docker volume.
- Added the native `zeke` plugin backed by ZekeFlow authority APIs.
- Added Sprout, Rambo internal, and external-client profile templates.
- Added profile-bound native tool contract tests.
- Cut Sprout and Rambo production compose files to the ZekeBot image digest.

## Upstream policy

ZekeBot stays close to upstream where possible. Local differences are documented in [ZekeBot versus upstream OpenClaw](/zekebot-vs-upstream), and upstream integration decisions are recorded outside the fork in Zeke governance.
