# Runbook: CI Breakage Triage

## Purpose
Restore CI health quickly and deterministically.

## Gate order
1. Docs gate
2. Lint
3. Build
4. Scroll/chat audit
5. API contract smoke
6. Chat e2e smoke

## Fast triage checklist
1. Reproduce failing command locally.
2. Capture failing step output and impacted files.
3. Check whether failure is environmental (gateway/provider) vs regression.
4. Patch minimally, rerun full gate set.

## Local verification commands
1. `npm run lint -- src`
2. `npm run build`
3. `npm run audit:scroll-chat:ci`
4. `npm run test:api-contract`
5. `npm run test:chat-e2e`

## Escalation
- If failure is external-provider or gateway availability, mark run as infra-dependent and attach mitigation notes to PR.

## Closure criteria
- All gate commands pass locally and in CI.
- Changelog + implementation log updated with fix summary.
