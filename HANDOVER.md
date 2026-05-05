# OpenClaw Handover Note

> Start here before touching gateway, dashboard, runtime, or production Agent configs.

## SSH First

Primary development happens on DevAgents.

```bash
ssh -i ~/.ssh/hetzner-openclaw root@204.168.223.245
```

If the local SSH alias is configured, this is equivalent:

```bash
ssh DevAgents
```

Working directories after connecting:

```bash
cd /root/projects/openclaw            # gateway/runtime work
cd /root/projects/openclaw-dashboard  # dashboard/UI/API work
```

Production hosts for verification only:

```bash
ssh -i ~/.ssh/hetzner-openclaw root@89.167.70.46   # EU prod / 1stClaw
ssh -i ~/.ssh/hetzner-openclaw root@5.161.84.219   # US standby / 2ndClaw
```

Do not hardcode a production server for an Agent change. Resolve the Agent server from dashboard/Firestore state or the dashboard API before using SSH or gateway RPC.

## Read Before Starting

Read these files in this order before writing code:

1. `/root/projects/openclaw/STATUS.md`
2. `/root/projects/openclaw/MULTI_AGENT_PROTOCOL.md`
3. `/root/projects/openclaw/AGENTS.md`
4. `/root/projects/openclaw/CODEX_TASK_BRIEF.md`
5. `/root/projects/openclaw-dashboard/AGENTS.md`
6. `/root/projects/openclaw-dashboard/CLAUDE.md`

If touching dashboard release flow, also read:

```bash
/root/projects/openclaw-dashboard/.github/workflows/deploy.yml
```

If touching gateway/runtime deploy flow, also read:

```bash
/opt/openclaw-ops/scripts/build-and-push.sh
/opt/openclaw-ops/scripts/deploy.sh
/root/projects/openclaw/docker-compose.yml
```

## Current Source Of Truth

- Repo-root `/root/projects/openclaw/STATUS.md` is the live project state.
- Do not use old local/legacy status copies unless the user explicitly asks.
- Keep GitHub as the source of truth. Before work:

```bash
cd /root/projects/openclaw
git fetch --all --tags --prune
git status -sb

cd /root/projects/openclaw-dashboard
git fetch --all --tags --prune
git status -sb
```

## Branch And PR Protocol

- One branch = one owner.
- Check `STATUS.md` before creating a branch.
- Never touch another agent's active branch or file area.
- Branch from fresh `main`.
- Use Conventional Commits.
- Push a branch, open a PR, squash-merge to `main`.
- No direct pushes to `main`.
- Update `STATUS.md` at session end with branch, PR, validation, deploy result, and next step.

## Dashboard Protocol

Default dashboard deploy path:

```text
branch -> typecheck/build -> commit -> PR -> squash merge -> GitHub Actions deploy -> Cloud Run tag -> prod verification
```

Validation:

```bash
cd /root/projects/openclaw-dashboard
npx tsc --noEmit
npm run build
```

Production:

- URL: `https://app.agentglob.com`
- CI/CD workflow: `/root/projects/openclaw-dashboard/.github/workflows/deploy.yml`
- Manual Cloud Run deploy is fallback only, not routine.

Recent relevant dashboard areas:

- Agent config template: `/root/projects/openclaw-dashboard/lib/agent-config-template.ts`
- Agent config save API: `/root/projects/openclaw-dashboard/app/api/agents/[agentId]/config/route.ts`
- Public chat API: `/root/projects/openclaw-dashboard/app/api/public/chat/[agentName]/route.ts`
- Public chat model list: `/root/projects/openclaw-dashboard/app/api/public/chat/[agentName]/models/route.ts`
- Agent config UI: `/root/projects/openclaw-dashboard/app/dashboard/[workspaceSlug]/agents/[agentId]/page.tsx`
- Landing chat UI: `/root/projects/openclaw-dashboard/app/chat/[agentName]/page.tsx`

## Gateway / Runtime Protocol

Default gateway deploy path:

```bash
cd /root/projects/openclaw
/opt/openclaw-ops/scripts/build-and-push.sh <tag>
/opt/openclaw-ops/scripts/deploy.sh <tag>
```

Tag format:

```text
vYYYY.M.D.N
vYYYY.M.D.N-hotfix
```

Validation:

```bash
cd /root/projects/openclaw
pnpm install
pnpm build
pnpm test
pnpm check
```

Important runtime paths:

```bash
/opt/openclaw/docker-compose.yml
/root/.openclaw/agents/{agent-name}/docker.env
/root/.openclaw/agents/{agent-name}/openclaw.json
/root/.openclaw/agents/{agent-name}/workspace
```

When inspecting live containers:

```bash
docker ps --format '{{.Names}} {{.Status}}'
docker logs --tail 120 {agent-name}-openclaw-gateway-1
```

Always redact secrets in logs/output.

## Model / Secret Notes

Core deploy-time keys:

```text
NVIDIA_API_KEY
VENICE_API_KEY
OPENAI_API_KEY
BRAVE_API_KEY
ELEVENLABS_API_KEY
```

These are owner-only in dashboard UI and should not be returned to member-role users.

Current NVIDIA model behavior to remember:

- UI label `GLM-5` maps to runtime model `nvidia/z-ai/glm-5.1`.
- Claude fallback is `venice/claude-opus-4-6`.
- Existing-agent configs need `models.providers.nvidia` definitions or OpenClaw can fail with `Unknown model`.
- DeepSeek-R1 via NVIDIA has returned provider-side `410` for the current key/account; public chat now retries Claude fallback when selected NVIDIA models fail.

Relevant recent fixes:

- Dashboard PR #61: NVIDIA public-chat/model-list/template fix.
- Gateway PR #10: pass `NVIDIA_API_KEY` into containers.
- Dashboard PR #62: backfill NVIDIA model definitions for existing configs.
- Dashboard PR #63: retry fallback for default public chat failures.
- OpenClaw PR #13: status docs for Jojo PM NVIDIA fallback repair.

## Production Smoke Tests

Useful public-chat checks:

```bash
curl -sS -m 120 -X POST 'https://app.agentglob.com/api/public/chat/designer' \
  -H 'content-type: application/json' \
  --data '{"message":"Reply with exactly: smoke-ok","sessionKey":"handover-smoke","model":"nvidia/z-ai/glm-5.1"}'

curl -sS -m 120 -X POST 'https://app.agentglob.com/api/public/chat/projectmanager' \
  -H 'content-type: application/json' \
  --data '{"message":"Reply with exactly: fallback-ok","sessionKey":"handover-fallback","model":"nvidia/deepseek-ai/deepseek-r1"}'
```

Expected behavior:

- `designer` with GLM-5 should reply.
- `projectmanager` with DeepSeek-R1 may use Claude fallback and should still reply.

## End-Of-Session Checklist

Before handing off:

1. Commit all intended changes.
2. Push branch and open PR.
3. Squash-merge if approved/appropriate.
4. Verify CI/deploy if dashboard changed.
5. Verify runtime if gateway/Agent config changed.
6. Update `/root/projects/openclaw/STATUS.md`.
7. Sync docs to GitHub.
8. Leave exact next step and any blockers.
