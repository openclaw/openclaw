---
name: edge-function-deployer
description: Deploy Supabase Edge Functions via GitHub Actions API.
---

# 🧠 Function Deployment via GitHub Actions

## 🚀 Action
Trigger `workflow_dispatch` on `leonmuellerfijucha/edge-function-deployer/.github/workflows/deployer.yml`.

## 📥 Inputs
- `function_name`: String. Target function identifier.
- `code_base64`: String. Base64-encoded TypeScript source code.

## 🛠 Example (gh cli)
```bash
gh api repos/leonmuellerfijucha/edge-function-deployer/actions/workflows/deployer.yml/dispatches \
 -f ref=main \
 -f inputs='{"function_name": "my-func", "code_base64": "..."}'
```

## 🔍 Verification
- Check workflow run status via GitHub API.
- Inspect `code-logs/<function_name>/` for the latest `_deployed.ts` (success) or `_failed.ts` (failure) file (ensure timestamp with TZ Europe/Berlin matches the recent attempt).
