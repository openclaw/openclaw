# Using Scripts in Skills

<purpose>
Scripts are executable code that Claude runs as-is rather than regenerating each time. They ensure reliable, error-free execution of repeated operations.
</purpose>

<when_to_use>
Use scripts when:
- The same code runs across multiple skill invocations
- Operations are error-prone when rewritten from scratch
- Complex shell commands or API interactions are involved
- Consistency matters more than flexibility

Common script types:
- **Deployment** - Deploy to Vercel, publish packages, push releases
- **Setup** - Initialize projects, install dependencies, configure environments
- **API calls** - Authenticated requests, webhook handlers, data fetches
- **Data processing** - Transform files, batch operations, migrations
- **Build processes** - Compile, bundle, test runners
</when_to_use>

<script_structure>
Scripts live in `scripts/` within the skill directory:

```
skill-name/
├── SKILL.md
├── workflows/
├── references/
├── templates/
└── scripts/
    ├── deploy.sh
    ├── setup.py
    └── fetch-data.ts
```

A well-structured script includes:
1. Clear purpose comment at top
2. Input validation
3. Error handling
4. Idempotent operations where possible
5. Clear output/feedback
</script_structure>

<script_example>
```bash
#!/bin/bash
# deploy.sh - Deploy project to Vercel
# Usage: ./deploy.sh [environment]
# Environments: preview (default), production

set -euo pipefail

ENVIRONMENT="${1:-preview}"

# Validate environment
if [[ "$ENVIRONMENT" != "preview" && "$ENVIRONMENT" != "production" ]]; then
    echo "Error: Environment must be 'preview' or 'production'"
    exit 1
fi

echo "Deploying to $ENVIRONMENT..."

if [[ "$ENVIRONMENT" == "production" ]]; then
    vercel --prod
else
    vercel
fi

echo "Deployment complete."
```
</script_example>

<workflow_integration>
Workflows reference scripts like this:

```xml
<process>
## Step 5: Deploy

1. Ensure all tests pass
2. Run `scripts/deploy.sh production`
3. Verify deployment succeeded
4. Update user with deployment URL
</process>
```

The workflow tells Claude WHEN to run the script. The script handles HOW the operation executes.
</workflow_integration>

<best_practices>
**Do:**
- Make scripts idempotent (safe to run multiple times)
- Include clear usage comments
- Validate inputs before executing
- Provide meaningful error messages
- Use `set -euo pipefail` in bash scripts

**Don't:**
- Hardcode secrets or credentials (use environment variables)
- Create scripts for one-off operations
- Skip error handling
- Make scripts do too many unrelated things
- Forget to make scripts executable (`chmod +x`)
</best_practices>

<security_considerations>
- Never embed API keys, tokens, or secrets in scripts
- Use environment variables for sensitive configuration
- Validate and sanitize any user-provided inputs
- Be cautious with scripts that delete or modify data
- Consider adding `--dry-run` options for destructive operations
</security_considerations>
