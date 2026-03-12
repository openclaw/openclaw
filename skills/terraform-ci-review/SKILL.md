---
name: terraform-ci-review
description: CI review and validation workflow for Morpho Terraform. Use when inspecting GitHub Actions, CI failures, or Terraform validation gates. Triggers on "CI", "github actions", "workflow", "terraform validate", "terraform fmt", "validation", "pipeline".
---

# Terraform CI Review

## Quick Start

- Check workflows in the target repo before triage; in `openclaw-sre`, relevant CI examples are `.github/workflows/ci.yml`, `.github/workflows/sre-substrate.yml`, and `.github/workflows/ecr-release.yml`.
- If CI red: `gh run list`, then `gh run view <id>`.
- Reproduce locally per matrix directory.

## CI Validation Matrix

- infrastructure
- projects/vault-config
- projects/commons
- projects/critical-monitoring
- projects/cognito
- projects/internal-docs

## Local Commands (per directory)

```bash
terraform fmt -check -recursive
terraform init -backend=false
terraform validate -no-color
```

## Rules

- No AWS creds required for CI validation.
- Never run terraform apply or destroy.
- Use severity prefixes in review comments: [CRITICAL] [HIGH] [MEDIUM] [LOW].
- Inline comments for line issues; top-level summary for overall.
