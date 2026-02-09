---
name: deploy-app
description: Deploy an application to production
metadata:
  requires:
    tools: ["shell", "git"]
  approval: "confirm"
  agent: "coder"
---

# Deploy Application

## Goal
Deploy the current application to production safely.

## Steps

### Step 1: Pre-flight Checks
- Run `git status` to ensure working tree is clean
- Run the test suite and ensure all tests pass
- Check the current branch (should be main/master or a release branch)

### Step 2: Build
- Run the build command for the project
- Verify build output exists and has no errors

### Step 3: Approval Gate
- Summarise what will be deployed:
  - Branch name
  - Latest commit message
  - Number of changes since last deploy
  - Test results summary
- Send to user via Telegram for approval
- Wait for [Approve] or [Cancel]

### Step 4: Deploy
- On approval, execute the deploy command
- Monitor deploy output for errors
- If deploy fails, capture error and notify user immediately

### Step 5: Verify
- Run health check against production URL
- If health check fails, notify user with option to rollback
- If successful, send confirmation with deploy summary

## Edge Cases
- If tests fail, stop immediately and report which tests failed
- If build fails, stop and report build errors
- Never force-push or skip CI checks
- If deploy takes >5 minutes, notify user it's still running
