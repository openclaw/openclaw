# Local Codex Fork-Style Clone Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a local fork-style clone of `https://github.com/OpenKnots/codex` at `~/Documents/GitHub/OpenKnots/codex` with the source remote renamed to `upstream`, without installing dependencies.

**Architecture:** This task is operational rather than product code. The work creates one local Git checkout, applies a single remote-name change, and verifies the resulting repository state with read-only Git commands.

**Tech Stack:** Git, shell

---

## Chunk 1: Create the local repository

### Task 1: Clone upstream into the target path

**Files:**

- Create: `~/Documents/GitHub/OpenKnots/codex/.git`
- Create: `~/Documents/GitHub/OpenKnots/codex/*`

- [ ] **Step 1: Confirm the target path is absent**

Run: `test -e /Users/val/Documents/GitHub/OpenKnots/codex && echo exists || echo missing`
Expected: `missing`

- [ ] **Step 2: Clone the repository**

Run: `git clone https://github.com/OpenKnots/codex /Users/val/Documents/GitHub/OpenKnots/codex`
Expected: Git clone completes without errors.

- [ ] **Step 3: Verify the checked out branch**

Run: `git -C /Users/val/Documents/GitHub/OpenKnots/codex branch --show-current`
Expected: `main`

## Chunk 2: Apply fork-style remote layout

### Task 2: Rename the default remote

**Files:**

- Modify: `~/Documents/GitHub/OpenKnots/codex/.git/config`

- [ ] **Step 1: Rename the remote**

Run: `git -C /Users/val/Documents/GitHub/OpenKnots/codex remote rename origin upstream`
Expected: Command exits successfully with no output.

- [ ] **Step 2: Verify the remotes**

Run: `git -C /Users/val/Documents/GitHub/OpenKnots/codex remote -v`
Expected: Fetch and push URLs are listed under `upstream`.

- [ ] **Step 3: Final sanity check**

Run: `git -C /Users/val/Documents/GitHub/OpenKnots/codex status --short --branch`
Expected: Branch output begins with `## main...` and shows a clean working tree.
