# RausserHQ Fork Policy

## Purpose

This fork exists to replace temporary compiled-dist overlays with source-level OpenClaw patches.

The current overlay and init-container approach is temporary. The future goal is a source-built image from this fork rather than overlays that patch compiled `/app/dist` files after upstream image build.

This bootstrap branch is infrastructure only. It does not change runtime behavior.

## Runtime Policy Boundaries

- Do not put Sam, Julia, Ryan, WifeOps, household-specific channel IDs, or household-specific routing policy in runtime code.
- Household-specific policy belongs in homelab-platform GitOps configuration.
- Runtime changes in this fork must stay generic, upstream-rebaseable, and suitable for review as source-level OpenClaw changes.

## Secret And Private Content Rules

Never commit or paste:

- Secrets or tokens.
- Kubeconfigs.
- OAuth files or OAuth material.
- Slack message bodies or private Slack content.
- Private files or local operator material.

Use placeholders in docs, tests, and examples when private identifiers would otherwise appear.

## Patch Rules

- Keep patches small.
- Keep patches source-level.
- Back patches with focused tests when behavior changes.
- Keep patches easy to rebase onto newer upstream tags.
- Prefer deleting temporary overlay code once the source-built fork replaces it.

## Production Image Rule

homelab-platform must pin any forked OpenClaw production image by digest, not by mutable tag alone.

## Non Goals

This bootstrap branch does not:

- Port OpenClaw patches.
- Modify runtime behavior.
- Change homelab-platform deployments.
- Touch Kubernetes.
- Enable any household-specific agent or policy.
- Build or publish production images.
- Move the existing rev21 overlay system.
