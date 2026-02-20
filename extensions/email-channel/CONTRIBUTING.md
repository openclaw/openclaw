# Contributing to Email Channel

Thank you for your interest in contributing to the Email Channel plugin for OpenClaw!

## Development Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/openclaw/openclaw.git
   cd openclaw/packages/email-channel
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Build the plugin**
   ```bash
   npm run build
   ```

## Testing

### Manual Testing

1. Create a test configuration in `~/.openclaw/openclaw.json`
2. Use a test email account (not your personal email)
3. Configure the email channel with your test account
4. Start OpenClaw Gateway: `openclaw gateway`
5. Send test emails and verify:
   - Email reception
   - AI response delivery
   - State persistence
   - Dashboard session history

### Testing Checklist

- [ ] IMAP connection established successfully
- [ ] SMTP sending works correctly
- [ ] Sender whitelist filtering works
- [ ] State file persists across restarts
- [ ] Duplicate emails are skipped
- [ ] Dashboard sessions are created
- [ ] Both read and unread emails are processed

## Code Style

- Use TypeScript for all source files
- Follow existing code formatting
- Add JSDoc comments for public APIs
- Use meaningful variable and function names

## Submitting Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m 'feat: Add my feature'`
4. Push to the branch: `git push origin feature/my-feature`
5. Open a Pull Request

## Commit Message Format

Follow conventional commits:

- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation changes
- `refactor:` Code refactoring
- `test:` Test additions or changes
- `chore:` Maintenance tasks

Example:

```
feat: Add support for OAuth2 authentication

- Implement OAuth2 flow for Gmail
- Add token refresh mechanism
- Update documentation
```

## Reporting Issues

When reporting issues, please include:

1. **OpenClaw version**: `openclaw --version`
2. **Node.js version**: `node --version`
3. **Operating system**: macOS, Linux, Windows
4. **Email provider**: Gmail, QQ, 163, Outlook, etc.
5. **Error messages**: Complete error logs from `/tmp/openclaw/`
6. **Steps to reproduce**: Detailed reproduction steps
7. **Expected behavior**: What you expected to happen
8. **Actual behavior**: What actually happened

## Feature Requests

We welcome feature requests! Please:

1. Check existing issues first
2. Describe the use case clearly
3. Explain why the feature would be useful
4. Consider if it fits the plugin's scope

## Security

**Important**: Never commit credentials or sensitive information!

- Use placeholder values in examples
- Test with dedicated test accounts
- Report security vulnerabilities privately

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
