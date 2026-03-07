---
summary: "Plan for a repeatable OpenClaw deployment using a fork and easy deploy"
read_when:
  - You want to ship a customized OpenClaw (extensions, skills, GCP) in a versioned, repeatable way
  - You want to merge upstream updates while keeping your customizations
  - You want one-source-of-truth for deploy (clone fork → run steps)
title: "Fork and deploy plan"
---

See also: [Multi-user context and keeping OpenClaw up to date](/reference/multi-user-and-upstream) for how openclaw-starter (config only) and a fork (code) work together.

# Fork and deploy plan (repeatable OpenClaw)

This document is the **plan** for making your OpenClaw solution repeatable: fork the repo, apply your changes, and enable easy deployment. Execute the steps in order once the plan is approved.

---

## 1. Goals

- **Repeatable**: Same steps produce the same running Gateway every time (same branch/tag, same config pattern).
- **Versioned**: Customizations (GIDR MCP, Firstlight skill, GCP example) live in one repo at a known revision.
- **Upstream-friendly**: Minimize customizations in core; keep them in extensions, skills, and config/docs so merging upstream stays simple.
- **Easy deploy**: Deploy by cloning the fork (and branch/tag) and running a small set of commands (optionally a single script).

---

## 2. Scope of customizations (what goes in the fork)

Only the following should be **added or changed** in the fork. Everything else stays as in upstream.

| Area                           | Contents                                                                                                        | Notes                                                                                                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Extensions**                 | `extensions/gidr-mcp/` (GIDR MCP client, `search_troubleshooting`, `retrieval_firstlight_noc`)                  | Optional plugin; enable via config + env                                                                                                                                                |
| **Skills**                     | `skills/firstlight/SKILL.md` (Firstlight NOC/troubleshooting, `/firstlight`)                                    | Bundled skill; agent sees it when GIDR env is set                                                                                                                                       |
| **System prompt**              | `src/agents/system-prompt.ts` (tool summaries + order for `search_troubleshooting`, `retrieval_firstlight_noc`) | Small additive change; keep in sync with upstream                                                                                                                                       |
| **Docs**                       | `docs/platforms/gcp.md` (example: gidr-demo, openclaw-gateway)                                                  | Example section only                                                                                                                                                                    |
| **This plan**                  | `docs/reference/fork-and-deploy-plan.md`                                                                        | This document                                                                                                                                                                           |
| **Deploy helper** (optional)   | Script or one-page doc that clones the fork and runs the GCP VM flow                                            | See step 5                                                                                                                                                                              |
| **Multi-instance maintenance** | `platforms/gcp-vm/manage-multi.sh` + README “Maintaining many instances”                                        | Deploy many OpenClaw containers side-by-side on one VM; one script to start/stop/restart/logs/pull/exec all                                                                             |
| **Customer starter template**  | `customer-starter/`                                                                                             | One repo as starting point for a new customer: multi-user context, Telegram + WhatsApp user onboarding; publish as standalone repo, clone and customize per customer (e.g. FirstLight). |
| **Observability**              | `extensions/langsmith-tracer/`                                                                                  | LangSmith tracing for the agent loop (LLM calls, tool calls, token usage). Opt-in via `LANGSMITH_API_KEY`; no-op when absent. See `extensions/langsmith-tracer/README.md`.              |

**Do not** change core under `src/` beyond the listed system-prompt edits unless necessary. Prefer extensions and skills so upstream merges stay clean.

---

## 3. Step 1 — Create and prepare the fork

1. **Fork** the OpenClaw repo (e.g. `openclaw/openclaw` → `YOUR_ORG/openclaw` or your user fork). Use GitHub (or your Git host) “Fork” and ensure you have push access.
2. **Clone the fork** locally (replace with your fork URL and branch name):

   ```bash
   git clone https://github.com/YOUR_ORG/openclaw.git
   cd openclaw
   ```

3. **Add upstream** so you can pull updates later:

   ```bash
   git remote add upstream https://github.com/openclaw/openclaw.git
   git fetch upstream
   ```

4. **Create a branch** for your deployment line (e.g. `deploy/gidr-demo` or `main-custom`):

   ```bash
   git checkout -b deploy/gidr-demo
   ```

5. **Apply your changes** to this branch:
   - Ensure all items in the “Scope of customizations” table above are present (extensions, skills, system-prompt tweaks, GCP example doc, this plan).
   - If you are starting from a fresh clone of the fork, re-apply or cherry-pick the same commits you used in the main repo (or copy the changed files).
6. **Commit and push** the branch to the fork:

   ```bash
   git add -A
   git status   # sanity check
   git commit -m “Add GIDR MCP extension, firstlight skill, GCP example, fork-and-deploy plan”
   git push -u origin deploy/gidr-demo
   ```

7. **(Optional)** Tag a release for deploy (e.g. `v2026.2.1-gidr.1`):

   ```bash
   git tag v2026.2.1-gidr.1
   git push origin v2026.2.1-gidr.1
   ```

   Deployment can then use this tag for reproducibility.

---

## 4. Step 2 — Keep the fork in sync with upstream

When you want to pull in upstream changes:

1. **Fetch and merge** (or rebase) from upstream:

   ```bash
   git fetch upstream
   git merge upstream/main   # or: git rebase upstream/main
   ```

2. **Resolve conflicts** if any. Most will be in:
   - `src/agents/system-prompt.ts` (tool list / summaries)
   - Any other file upstream changed that you also changed.
3. **Re-run your tests and a quick deploy test** (e.g. build, start gateway, smoke test).
4. **Push** the updated branch (and optionally a new tag):

   ```bash
   git push origin deploy/gidr-demo
   # optional: git tag v2026.2.1-gidr.2 && git push origin v2026.2.1-gidr.2
   ```

---

## 5. Step 3 — Define “easy deployment”

Choose one of the following (or both). The goal is: **one canonical way** to go from “fork repo” to “Gateway running on the VM”.

### Option A — Documented steps (no new script)

- **Location**: Keep using the existing [GCP doc](/platforms/gcp) and [Docker install](/install/docker).
- **Change**: In the “Clone OpenClaw” step, document that for this deployment we clone **the fork** and **branch/tag**:
  - Clone URL: `https://github.com/YOUR_ORG/openclaw.git`
  - Branch or tag: `deploy/gidr-demo` or `v2026.2.1-gidr.1`
- **Example** (for gidr-demo, openclaw-gateway): On the VM after SSH, run:

  ```bash
  git clone --branch deploy/gidr-demo https://github.com/YOUR_ORG/openclaw.git openclaw
  cd openclaw
  # then continue with: create ~/.openclaw, ~/.openclaw/workspace, .env, docker-compose as in the GCP doc
  ```

- **Secrets**: Document that `GIDR_MCP_URL` and `GIDR_API_KEY` (or `GIDR_API_KEY_FILE`) must be set (e.g. in `.env` or the environment) for the Firstlight tools to work. Optionally reference a secrets manager (e.g. GCP Secret Manager) without embedding secrets in the doc.

### Option B — Deploy script in the fork

- **Location**: e.g. `scripts/deploy-from-fork.sh` or `platforms/gcp-vm/deploy-from-fork.sh` in the fork.
- **Responsibilities** (high level):
  1. Run on the **VM** (or from a runner that SSHs to the VM).
  2. Ensure dependencies (Docker, git) are present.
  3. Clone the fork (or pull if already cloned) at the chosen branch/tag.
  4. Create `~/.openclaw` and `~/.openclaw/workspace` if missing.
  5. Copy or symlink a provided `.env` (or template) and optionally pull secrets from env / a secrets store.
  6. Run the same `docker compose -f platforms/gcp-vm/docker-compose.yml --env-file .env up -d openclaw-gateway` (or equivalent) as in the GCP doc.
- **Inputs**: Branch or tag, clone URL, path to `.env` or template. No secrets in the script; secrets come from env or files the operator provides.
- **Doc**: Add a short section in this plan or in the GCP VM README: “To deploy from the fork, run: `./scripts/deploy-from-fork.sh …`” with the exact command and required env vars.

---

## 6. Step 4 — GCP and config checklist (per environment)

For each environment (e.g. gidr-demo / openclaw-gateway):

- [ ] **GCP**: Project and VM exist (or create per [GCP doc](/platforms/gcp) example).
- [ ] **Fork**: Clone uses the fork URL and the chosen branch/tag.
- [ ] **Env**: `GIDR_MCP_URL` and `GIDR_API_KEY` (or `GIDR_API_KEY_FILE`) set where the Gateway runs (e.g. in `.env` for Docker).
- [ ] **Config**: Agent has the GIDR tools allowlisted, e.g. in `openclaw.yml`:

  ```yaml
  tools:
    alsoAllow: ["search_troubleshooting", "retrieval_firstlight_noc"]
  # or: alsoAllow: ["gidr-mcp"]
  ```

- [ ] **Plugins**: Extension `gidr-mcp` is enabled (default if present in repo; ensure it’s not disabled in config).
- [ ] **Access**: SSH tunnel (or controlled port exposure) for Control UI; gateway token pasted once in the UI.

---

## 7. Step 5 — Execution order (summary)

Execute in this order:

1. **Fork and branch** (Step 1): Create fork, add upstream remote, create deployment branch, apply customizations, push, optionally tag.
2. **Deploy definition** (Step 3): Either update the GCP doc with “clone from fork” (Option A) or add and document the deploy script (Option B).
3. **First deploy**: On a test VM (or existing gidr-demo VM), follow the chosen deploy path (doc or script), then verify:
   - Gateway starts.
   - Control UI is reachable via tunnel.
   - Agent can use `search_troubleshooting` and `retrieval_firstlight_noc` when configured (and `/firstlight` skill is available).
4. **Sync process** (Step 2): Use it whenever you want to pull upstream; re-test and re-tag as needed.
5. **Checklist** (Step 4): Use the per-environment checklist for any new VM or environment.

---

## 8. Optional: CI and pre-built images

- **CI**: In the fork, add a small CI job (e.g. GitHub Actions) that on push to the deploy branch (or on tag):
  - Runs `pnpm build` and `pnpm test` (or equivalent).
  - Optionally builds a Docker image and pushes it to a registry (e.g. GCR, Artifact Registry).
- **Deploy from image**: If you use a pre-built image, the VM can pull that image instead of building from source; the “clone fork” step is then only for config/scripts, or replaced by “pull image and run” with env/config mounted. This is optional and can be added after the basic “clone fork + compose” flow is stable.

---

## 9. Doc links

- [GCP platform guide](/platforms/gcp) — Full GCP setup; includes gidr-demo / openclaw-gateway example.
- [Docker install](/install/docker) — Docker Compose setup and configuration.
- [Docker install](/install/docker) — Generic Docker-based install.
- [Slash commands](/tools/slash-commands) — Includes `/firstlight` when the firstlight skill is loaded.

After execution, you can point operators to this plan and the chosen deploy path (doc or script) for repeatable deployments.
