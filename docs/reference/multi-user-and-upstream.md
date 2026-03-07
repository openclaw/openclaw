---
summary: "How multi-user context works and how to modify OpenClaw while staying up to date"
read_when:
  - You use openclaw-starter (config only) and want to know where multi-user support lives
  - You need to change OpenClaw code (plugins, extensions, skills) and still pull upstream updates
title: "Multi-user context and keeping OpenClaw up to date"
---

# Multi-user context and keeping OpenClaw up to date

## Two repos, two roles

| Repo                                                 | Role                     | Contains                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **openclaw** (or your fork)                          | The application          | Gateway, channels, session routing, `dmScope` / `identityLinks`, plugins, extensions. **Multi-user context is implemented here.**                          |
| **openclaw-starter** (e.g. GIDR-AI/openclaw-starter) | Customer config + deploy | Config templates (`session.dmScope`, `session.identityLinks`), deployment env, scripts to copy config to VM and start the container. **No OpenClaw code.** |

Multi-user context (`session.dmScope: "per-peer"`, `session.identityLinks`) is **already implemented in the main OpenClaw repo**. The starter only holds **config and docs** that use those features. You do **not** need to modify OpenClaw for basic multi-user—just run OpenClaw (upstream or your fork) on the VM and point it at your openclaw-starter config.

If you need **optional** behavior (e.g. an inject plugin that reads `users/<key>.md` and injects `prependContext` via `before_agent_start`), that can live in an extension in your fork or in a separate plugin repo; the hook API is in OpenClaw core.

---

## When you need to modify OpenClaw

If you add or change **code** in OpenClaw (extensions, skills, system prompt, GCP helpers, or any file under `src/` or `extensions/`), use a **fork** and keep it in sync with upstream so you get security and feature updates.

### Pattern: fork + upstream sync

1. **Fork** the repo (e.g. `openclaw/openclaw` → `GIDR-AI/openclaw`).
2. **Add upstream** and create a branch for your customizations:

   ```bash
   git remote add upstream https://github.com/openclaw/openclaw.git
   git fetch upstream
   git checkout -b deploy/gidr   # or main, or a release branch
   ```

3. **Apply your changes** on that branch (extensions, skills, config defaults, docs). Prefer extensions and skills over core changes so merges stay clean.
4. **Deploy from your fork** on the VM (clone your fork and branch; build/run Docker from there). Your openclaw-starter config still points at the same gateway; only the **binary/image** comes from your fork.
5. **Keep up to date** by merging (or rebasing) upstream into your branch:

   ```bash
   git fetch upstream
   git merge upstream/main   # or: git rebase upstream/main
   ```

   Resolve conflicts (often in `src/agents/system-prompt.ts` or other files you touched), run tests, then push.

Full steps and scope: [Fork and deploy plan](/reference/fork-and-deploy-plan).

---

## Summary

- **Multi-user context:** Implemented in OpenClaw. openclaw-starter provides config and checklists; no code changes required.
- **Modifying OpenClaw and staying up to date:** Fork → add upstream remote → do changes on a branch → deploy from fork → periodically `git fetch upstream && git merge upstream/main`.
