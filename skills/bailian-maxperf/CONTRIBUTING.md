# Contributing to Bailian MaxPerf Skill

Thank you for considering contributing to this OpenClaw skill! This document provides guidelines and instructions for contributing.

## How to Contribute

### Reporting Issues

Before creating an issue, please:
1. Check existing issues to avoid duplicates
2. Verify the issue with the latest version
3. Collect relevant information:
   - OpenClaw version (`openclaw --version`)
   - Node.js version (`node --version`)
   - Operating system
   - Error messages/logs

When creating an issue, include:
- Clear description of the problem
- Steps to reproduce
- Expected behavior
- Actual behavior
- Screenshots (if applicable)

### Submitting Pull Requests

1. **Fork** the repository
2. **Create a branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **Make your changes**
   - Follow existing code style
   - Add comments for complex logic
   - Update documentation if needed

4. **Test your changes**
   ```bash
   ./scripts/maxperf.sh
   openclaw status
   ```

5. **Commit your changes**
   - Use clear, descriptive commit messages
   - Reference issues when applicable
   ```bash
   git commit -m "feat: add support for new model XYZ"
   ```

6. **Push and create PR**
   ```bash
   git push origin feature/your-feature-name
   ```

### Pull Request Guidelines

**PR Title Format:**
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `refactor:` - Code refactoring
- `test:` - Test additions/changes
- `chore:` - Maintenance tasks

**PR Description Template:**
```markdown
## Description
Brief description of changes

## Related Issue
Fixes #123

## Testing
- [ ] Tested with OpenClaw 2026.3.13
- [ ] Verified token statistics
- [ ] Checked model configuration

## Checklist
- [ ] Code follows project guidelines
- [ ] Documentation updated
- [ ] No breaking changes (or documented)
```

## Code Style

### Shell Scripts
- Use `set -e` for error handling
- Quote variables: `"$VAR"`
- Use meaningful variable names
- Add comments for complex operations

### JSON Configuration
- Use 2-space indentation
- Keep keys in alphabetical order when possible
- Include comments for non-obvious values

### Documentation
- Use clear, concise language
- Include examples for all features
- Keep README.md and README.en.md in sync

## Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/openclaw/openclaw.git
   cd openclaw/skills/bailian-maxperf
   ```

2. **Install OpenClaw** (if not already installed)
   ```bash
   npm install -g openclaw
   ```

3. **Configure Bailian provider** in `~/.openclaw/openclaw.json`

4. **Test the skill**
   ```bash
   ./scripts/maxperf.sh
   ```

## Release Process

1. Update version in SKILL.md
2. Update CHANGELOG.md
3. Create git tag
4. Submit to ClawHub

## Questions?

- Open an issue for general questions
- Join OpenClaw Discord: https://discord.com/invite/clawd
- Check documentation: https://docs.openclaw.ai

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
