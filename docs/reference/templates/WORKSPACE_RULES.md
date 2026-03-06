---
summary: "What you can and cannot edit; how to change code via PR; GitHub collaboration workflow"
read_when:
  - You need to know which workspace files are read-only
  - You want to propose codebase or TOOLS changes
  - You are creating issues, branches, or PRs for the repo
---

# WORKSPACE_RULES.md – What You Can and Cannot Change

## Files you cannot edit

In this environment the following files are **read-only** (immutable). Do not try to edit or overwrite them; writes will fail or be ignored.

- **SOUL.md** – Core truths and social contract. Use **SOUL_PLUS.md** to add context.
- **IDENTITY.md** – Your assigned identity. Use **IDENTITY_PLUS.md** to add context.
- **USER.md** – Your human’s profile. Use **USER_PLUS.md** to add context.
- **TOOLS.md** – Tool/skill definitions. Changes to tools or code require a **pull request** (see below).

You can read these files. To change behavior or identity, use the corresponding `*_PLUS.md` files in the workspace, or propose code/tool changes via a PR.

## Files you can edit

You **can** create and edit:

- **AGENTS.md**, **BOOT.md**, **BOOTSTRAP.md**, **HEARTBEAT.md**
- **SOUL_PLUS.md**, **IDENTITY_PLUS.md**, **USER_PLUS.md**
- **MEMORY.md**, **memory.md**, and files under **memory/** (e.g. `memory/YYYY-MM-DD.md`)

## Codebase and TOOLS changes via GitHub PR

You **can** enact changes to the OpenClaw codebase, TOOLS.md, or other repo files by **opening a pull request** on GitHub. Use the **GitHub skill** (the `gh` CLI) to create branches, commit changes, and open PRs.

### GitHub env vars (for PR workflow)

When running in Docker (or when the gateway is configured for PR workflow), the operator may set:

- **OPENCLAW_GITHUB_REPO** – Target repo in **owner/repo** form only (e.g. `myorg/my-repo`). This is how `gh` knows which repo to interact with. Do **not** use a URL (no `https://...` or `git@...`). Use with `gh --repo $OPENCLAW_GITHUB_REPO` when creating PRs.
- **GH_TOKEN** or **GITHUB_TOKEN** – Either is fine; the `gh` CLI accepts both. Token must have permissions to create branches and open PRs in that repo.

If these are set, you can use the GitHub skill to create pull requests. If they are not set, you cannot create PRs from this environment; suggest the operator set them for PR-based code changes.

### GitHub repo access and collaboration workflow

- **Branches:** You may push to your own branches. The **main** branch is protected: changes reach main **only via pull request**, and PRs must be **approved by at least one other person** (typically the operator) before merge.
- **Audit trail:** For **any** code change, create a **GitHub issue** first. Use issues as the audit trail and to link PRs.
- **Issue tags and approval:**
  - **sensitive**, **security-related**, **important**, or **need-human-input** (or human-requested): get **approval in a comment on the issue** from the operator before implementing.
  - **small fixes**, **improvements**, etc.: you may proceed without prior discussion but **still create an issue** to track the change, then implement and open a PR that references it.

**Step-by-step workflow:**

1. **Create an issue** describing the change (or use an existing one). Tag it appropriately (e.g. `sensitive`, `security`, `important`, `need-human-input`, or leave untagged for small fixes).
2. **Pull latest** from the base branch (usually `main`) on the fork/upstream you use.
3. **Create a new branch** with naming: **`<agent-name>-<issue-tag>-<short-branch-content-slug>`** (e.g. `agent-fix-memory-compaction-edge-case` or `agent-security-auth-validation`). Use a short, descriptive slug.
4. **Make changes** and **add or update unit tests** for the change. Do not skip tests.
5. **Commit** only when tests pass and the code satisfies the issue. Write clear commit messages.
6. **Push** the branch and **open a PR** into `main`. In the PR:
   - Write a **clean, well-documented summary** of the changes.
   - **Link the PR to one or more issues** (e.g. "Fixes #123" or "Related to #45").
7. **After review:**
   - If the PR is **accepted**: update or close the linked issue(s).
   - If the PR is **requested changes**: update the code, push, and resubmit for review.
   - If the PR is **rejected**: record that in the originating issue (e.g. comment that the approach was rejected and why).

### Discord channel (optional)

If configured, all **discussion and alerts** for GitHub workflow can happen in a dedicated Discord channel: issue created, new PR opened, PR accepted/rejected, review comments, responses, etc. When you take GitHub actions (create an issue, open a PR, etc.), post a short summary to this channel so the operator and others can follow along.

This keeps a safe, clean workflow for agentically improving the codebase with human oversight and a single place for GitHub-related conversation.

---

_Respect read-only files; use *_PLUS for identity/soul/user and PRs for code and TOOLS. Issue first, branch from main, tests required, PR to main with approval._
