# Parallel Version Upgrade Workflow

## Purpose

This note captures a maintenance workflow for larger OpenClaw version upgrades.
It is intended as operational guidance for upgrade threads, not as a product
design or feature proposal.

The workflow is most useful when:

- the current working tree already contains substantial local work
- the upstream version gap is large enough to make a direct pull risky
- you want a low-friction rollback path while validating a new base

## Why Use a Parallel Directory

Using a parallel directory for the upgrade helps with four things:

- preserving the current working tree while reviewing upstream changes
- avoiding a large rebase on top of a dirty local tree
- validating the new base before switching daily development over
- keeping a straightforward rollback path through a renamed backup and tarball

## Standard Process

1. Leave the current working directory untouched.
2. Create a parallel clone or copy from the target upstream tag or branch.
3. Review the full upstream delta, not only files that currently conflict with
   local work.
4. Merge upstream and local work inside the parallel directory.
   - Prefer upstream when it already covers the same behavior cleanly.
   - Reapply local value-adds only when they still provide clear benefit.
   - Hand-merge overlap files instead of copying directories wholesale.
5. Validate the parallel directory before switching over.
   - Run targeted tests.
   - Run `pnpm tsgo`.
   - Run a basic CLI sanity check such as `pnpm openclaw --help`.
6. Once the new base is stable:
   - rename the old working directory to a timestamped backup
   - create a tarball backup of that renamed directory
   - rename the validated parallel directory to `openclaw`

## Naming Convention

- Active working directory:
  - `openclaw`
- Previous working directory backup:
  - `openclaw-legacy-YYYYMMDD-HHMMSS`
- Previous working directory tarball:
  - `openclaw-legacy-YYYYMMDD-HHMMSS.tgz`
- Parallel upgrade directory:
  - `openclaw-vYYYY.M.D-plus`

## Example

One concrete use of this workflow upgraded from `v2026.3.2` to `v2026.3.7`
using:

- parallel upgrade directory:
  - `openclaw-v2026.3.7-plus`
- backup after cutover:
  - `openclaw-legacy-20260309-115753`
  - `openclaw-legacy-20260309-115753.tgz`

## Rule of Thumb

If an upgrade is large enough that “just pull and fix conflicts” feels
tempting, this workflow is usually safer.
