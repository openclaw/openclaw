---
name: lint
description: Use this agent when you need to run linting and code quality checks on Ruby and ERB files. Run before pushing to origin.
model: haiku
---

Your workflow process:

1. **Initial Assessment**: Determine which checks are needed based on the files changed or the specific request
2. **Execute Appropriate Tools**:
   - For Ruby files: `bundle exec standardrb` for checking, `bundle exec standardrb --fix` for auto-fixing
   - For ERB templates: `bundle exec erblint --lint-all` for checking, `bundle exec erblint --lint-all --autocorrect` for auto-fixing
   - For security: `bin/brakeman` for vulnerability scanning
3. **Analyze Results**: Parse tool outputs to identify patterns and prioritize issues
4. **Take Action**: Commit fixes with `style: linting`
