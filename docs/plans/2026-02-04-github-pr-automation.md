# GitHub PR Automation for Agent-to-Agent Collaboration

**Date:** 2026-02-04
**Status:** Planning
**Goal:** Enable agents to create, review, comment, and approve PRs automatically without manual intervention

---

## Current State Analysis

### What Works Today

1. **PR Creation (Partial)** - Agents can run `gh pr create` via bash exec tool
   - **Issue:** Requires interactive input when parameters missing
   - **Location:** `gh` CLI commands executed through `src/agents/bash-tools.exec.ts`

2. **PR Review (Read-Only)** - Agents can inspect PRs via:
   - `gh pr view <PR#>` - fetch PR metadata
   - `gh pr diff <PR#>` - view code changes
   - **Location:** Documented in `CLAUDE.md` lines 82-100

3. **Bash Execution Infrastructure** - Full shell access via `exec` tool
   - PTY mode for interactive CLIs
   - Background execution with process monitoring
   - Git author injection from config
   - **Location:** `src/agents/bash-tools.exec.ts`

### What's Missing

1. **Non-Interactive PR Creation** - Need complete parameters to avoid prompts
2. **PR Review Actions** - Comment, approve, request changes
3. **PR Approval Workflow** - Programmatic approval without manual click
4. **Agent Coordination** - Workflow for Agent A → PR → Agent B review cycle

---

## Solution Design

### 1. Automated PR Creation

**Problem:** `gh pr create` requires manual input when missing title, body, or base branch.

**Solution:** Always provide complete parameters:

```bash
gh pr create \
  --repo owner/repo \
  --head feature-branch \
  --base main \
  --title "fix: description" \
  --body "Detailed description with context" \
  --draft  # optional: create as draft first
```

**Agent Implementation:**
```typescript
// When agent creates PR, use this pattern:
const prCommand = `
gh pr create \\
  --repo ${repo} \\
  --head ${branchName} \\
  --base ${baseBranch} \\
  --title "${title}" \\
  --body "$(cat <<'EOF'
${prBody}
EOF
)" \\
  --no-maintainer-edit
`;

await exec({
  command: prCommand,
  workdir: repoPath,
  pty: true,
  elevated: false
});
```

**Key Points:**
- Use heredoc (`<<'EOF'`) for multi-line body to avoid shell escaping issues
- `--no-maintainer-edit` prevents interactive prompt
- Always specify `--base` explicitly (defaults can change)
- PTY mode required for gh CLI

---

### 2. PR Review and Commenting

**Available Commands:**

```bash
# Add a review comment
gh pr comment <PR#> --body "Review feedback here"

# Add inline code comments (requires file path and line number)
gh pr comment <PR#> \
  --body "Inline comment" \
  --subject "path/to/file.ts" \
  --line 42

# Request changes
gh pr review <PR#> --request-changes --body "Changes needed: ..."

# Approve PR
gh pr review <PR#> --approve --body "LGTM! Approved."

# Comment without explicit approval/rejection
gh pr review <PR#> --comment --body "Some thoughts..."
```

**Agent Implementation Pattern:**

```typescript
// After reviewing code changes
const reviewCommand = `
gh pr review ${prNumber} \\
  --approve \\
  --body "$(cat <<'EOF'
## Review Summary

**Verdict:** APPROVED ✓

**Key Changes:**
- Change 1
- Change 2

**Tested:** Yes
**CI Passing:** Yes

All checks passed. Ready to merge.
EOF
)"
`;

await exec({
  command: reviewCommand,
  workdir: repoPath,
  pty: true
});
```

---

### 3. PR Approval Requirements

**GitHub Permissions Needed:**

1. **Personal Access Token (PAT)** or **GitHub App** with:
   - `repo` scope (full repository access)
   - `pull_requests:write` permission
   - `contents:write` for merging

2. **Branch Protection Rules** (if enabled):
   - Reviewer must have write access
   - May require minimum reviewers (e.g., 1 approval)
   - May require status checks to pass

3. **Authentication:**
   - `gh auth login` must be run first
   - Token stored in `~/.config/gh/hosts.yml`
   - Agent inherits gh auth from environment

**Verification:**
```bash
# Check current auth status
gh auth status

# Check PR permissions
gh api repos/owner/repo/collaborators/username/permission

# Test approval (dry-run not available, but can check status)
gh pr view <PR#> --json reviewDecision,reviews
```

---

### 4. Two-Agent PR Workflow

**Scenario:** Agent A creates PR → Agent B reviews and approves → Merge

#### Agent A: Create PR

```typescript
// 1. Create feature branch
await exec({
  command: 'git checkout -b agent-a-feature',
  workdir: repoPath
});

// 2. Make changes, commit
await exec({
  command: `git add . && git commit -m "feat: new feature"`,
  workdir: repoPath
});

// 3. Push branch
await exec({
  command: 'git push -u origin agent-a-feature',
  workdir: repoPath
});

// 4. Create PR
const prCreateCmd = `
gh pr create \\
  --base main \\
  --head agent-a-feature \\
  --title "feat: new feature" \\
  --body "$(cat <<'EOF'
## Summary
New feature implementation

## Changes
- Added X
- Updated Y

## Testing
All tests pass

cc @agent-b for review
EOF
)" \\
  --no-maintainer-edit
`;

const result = await exec({
  command: prCreateCmd,
  workdir: repoPath,
  pty: true
});

// Extract PR number from output
const prUrl = result.stdout.trim(); // https://github.com/owner/repo/pull/123
const prNumber = prUrl.split('/').pop();
```

#### Agent B: Review and Approve

```typescript
// 1. Fetch PR details
const prDetails = await exec({
  command: `gh pr view ${prNumber} --json title,body,headRefName,baseRefName,commits`,
  workdir: repoPath
});

// 2. Review code changes (spawn coding agent or use diff)
const diffResult = await exec({
  command: `gh pr diff ${prNumber}`,
  workdir: repoPath
});

// 3. Run checks in isolated workspace
const reviewDir = await exec({
  command: 'mktemp -d',
});
const tempDir = reviewDir.stdout.trim();

await exec({
  command: `git clone https://github.com/owner/repo.git ${tempDir}`,
});

await exec({
  command: `gh pr checkout ${prNumber}`,
  workdir: tempDir
});

// Run tests
await exec({
  command: 'pnpm install && pnpm test',
  workdir: tempDir,
  timeout: 300
});

// 4. Post review
const reviewCmd = `
gh pr review ${prNumber} \\
  --approve \\
  --body "$(cat <<'EOF'
## Agent B Review

**Status:** ✅ APPROVED

**Checks Performed:**
- Code quality: PASS
- Tests: PASS (all 47 tests)
- Build: PASS
- Lint: PASS

**Summary:**
Changes look good. All automated checks passed. Safe to merge.
EOF
)"
`;

await exec({
  command: reviewCmd,
  workdir: repoPath,
  pty: true
});

// 5. Clean up temp directory
await exec({
  command: `rm -rf ${tempDir}`
});
```

#### Merge Flow

```bash
# Option 1: Auto-merge (if enabled and checks pass)
gh pr merge <PR#> --auto --squash

# Option 2: Immediate merge
gh pr merge <PR#> --squash --delete-branch

# Option 3: Wait for CI then merge
gh pr checks <PR#> --watch
gh pr merge <PR#> --squash --delete-branch
```

---

## Implementation Checklist

### Prerequisites

- [ ] GitHub CLI (`gh`) installed and authenticated
- [ ] PAT or GitHub App with `repo` and `pull_requests:write` scope
- [ ] Repository write access for reviewing agents
- [ ] Git author configured in agent config (`agents.defaults.commitAuthor`)

### Agent A (PR Creator) Setup

- [ ] Implement non-interactive `gh pr create` with all parameters
- [ ] Use heredoc for PR body to avoid escaping issues
- [ ] Always specify `--base` and `--head` explicitly
- [ ] Extract PR number from command output
- [ ] Tag reviewer agent in PR body (e.g., `cc @agent-b`)

### Agent B (Reviewer) Setup

- [ ] Fetch PR details with `gh pr view --json`
- [ ] Clone to temp workspace for isolated testing
- [ ] Checkout PR branch with `gh pr checkout`
- [ ] Run automated checks (tests, lint, build)
- [ ] Post review with `gh pr review --approve/--request-changes`
- [ ] Clean up temp workspace after review

### Workflow Orchestration

- [ ] Agent A notifies Agent B when PR is created (via channel message or webhook)
- [ ] Agent B listens for PR events (GitHub webhooks or polling)
- [ ] Agent B reviews automatically when tagged
- [ ] Agent A monitors for approval and merges
- [ ] Both agents update project memory with PR outcomes

---

## Testing Strategy

### Manual Testing

1. **Create PR without interaction:**
   ```bash
   gh pr create --base main --head test-branch --title "Test" --body "Test PR" --no-maintainer-edit
   ```

2. **Review and approve:**
   ```bash
   gh pr review <PR#> --approve --body "LGTM"
   ```

3. **Check review status:**
   ```bash
   gh pr view <PR#> --json reviewDecision,reviews
   ```

### Automated Testing

1. Create test repository with dummy PRs
2. Run agent workflow end-to-end
3. Verify PR creation, review, approval, merge
4. Check for leftover branches, temp directories
5. Test error cases (CI failure, merge conflicts)

---

## Security Considerations

1. **Token Security:**
   - Store GitHub PAT in secure credential store (1Password, env vars)
   - Never log or expose token in command output
   - Rotate tokens regularly

2. **Code Review Quality:**
   - Agent B must actually analyze code, not rubber-stamp
   - Run real tests before approving
   - Check for security vulnerabilities (SQL injection, XSS, etc.)
   - Validate commit author and sign-off

3. **Branch Protection:**
   - Don't bypass required checks with admin override
   - Respect CODEOWNERS rules
   - Follow merge strategy (squash vs rebase vs merge)

4. **Audit Trail:**
   - Log all PR actions (create, review, approve, merge)
   - Store review decisions in project memory
   - Track which agent approved which PR

---

## Integration with Existing Codebase

### Where to Add GitHub Tools

**Option 1: Extend bash-tools.exec.ts**
- Add helper functions like `createPR()`, `reviewPR()`, `approvePR()`
- Wrap `gh` CLI commands with proper error handling
- Return structured results (PR number, approval status)

**Option 2: Create dedicated github-tools.ts**
```typescript
// src/agents/github-tools.ts
import { z } from 'zod';

export const githubTools = {
  createPR: {
    description: 'Create a GitHub pull request',
    parameters: z.object({
      repo: z.string().describe('Repository (owner/repo)'),
      base: z.string().describe('Base branch (e.g., main)'),
      head: z.string().describe('Feature branch name'),
      title: z.string().describe('PR title'),
      body: z.string().describe('PR description'),
      draft: z.boolean().optional().describe('Create as draft PR')
    }),
    execute: async (params) => {
      // Implementation using gh CLI
    }
  },

  reviewPR: {
    description: 'Review and approve/reject a pull request',
    parameters: z.object({
      repo: z.string(),
      prNumber: z.number(),
      action: z.enum(['approve', 'request-changes', 'comment']),
      body: z.string().describe('Review comment')
    }),
    execute: async (params) => {
      // Implementation using gh CLI
    }
  }
};
```

**Option 3: Add to coding-agent skill**
- Update `skills/coding-agent/SKILL.md` with GitHub workflow examples
- Add templates for common PR operations
- Document multi-agent coordination patterns

### Configuration Updates

Add to `agents.defaults` in config:
```json
{
  "agents": {
    "defaults": {
      "github": {
        "autoCreatePR": true,
        "autoReview": false,  // require explicit approval
        "reviewTimeout": 300,  // 5 minutes
        "mergeStrategy": "squash",
        "deleteBranchAfterMerge": true
      }
    }
  }
}
```

---

## Next Steps

1. **Phase 1: PR Creation**
   - Implement non-interactive `gh pr create` in Agent A
   - Test with real repository
   - Verify PR appears without manual click

2. **Phase 2: PR Review**
   - Implement review workflow in Agent B
   - Add code analysis (tests, lint, security)
   - Post review comments with structured feedback

3. **Phase 3: Approval & Merge**
   - Implement `gh pr review --approve`
   - Add merge automation
   - Clean up branches and temp workspaces

4. **Phase 4: Multi-Agent Coordination**
   - Add webhook listener for PR events
   - Implement agent notification system
   - Track PR lifecycle in project memory

---

## References

- **GitHub CLI Docs:** https://cli.github.com/manual/gh_pr
- **Current Implementation:** `CLAUDE.md` lines 82-100
- **Coding Agent Guide:** `skills/coding-agent/SKILL.md` lines 121-154
- **Bash Tool:** `src/agents/bash-tools.exec.ts`
- **System Prompt:** `src/agents/system-prompt.ts`
