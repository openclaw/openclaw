# Contributing to Rust Plugin

Thank you for your interest in contributing! This document provides guidelines for contributing to the Rust plugin.

## 🚀 Quick Start

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run tests: `pnpm test`
5. Commit changes: `git commit -m "Add my feature"`
6. Push and create a pull request

## 📋 Development Setup

### Prerequisites

- **Node.js:** 18+ or 20+ (recommended 22+)
- **pnpm:** Latest version
- **Rust:** 1.75+ with `napi-rs/cli` installed

### Installation

```bash
# Install dependencies
pnpm install

# Build native module (for development)
pnpm build

# Run tests
pnpm test
```

## 🧪 Project Structure

```
extensions/rust-plugin/
├── src/                    # TypeScript/JavaScript bindings
│   ├── index.ts           # Main entry point
│   └── index.d.ts         # TypeScript definitions
├── native/                # Rust native module
│   ├── src/               # Rust source code
│   │   ├── lib.rs         # Main module
│   │   ├── crypto.rs       # Cryptography functions
│   │   ├── data.rs         # Data processing
│   │   ├── advanced.rs     # Advanced features
│   │   └── pure_logic.rs  # Pure logic functions
│   ├── Cargo.toml          # Rust dependencies
│   └── package.json        # NAPI configuration
├── tests/                  # Test suite
│   ├── crypto.test.ts
│   ├── data.test.ts
│   ├── advanced.test.ts
│   └── comprehensive.test.ts
├── docs/                   # Documentation
│   ├── USER_GUIDE.md
│   ├── DEVELOPER_GUIDE.md
│   └── reports/           # Audit reports
├── package.json            # npm configuration
└── openclaw.plugin.json  # OpenClaw manifest
```

## 📝 Code Style

### Rust

- Follow Rust naming conventions (snake_case for variables, PascalCase for types)
- Use `//` for documentation comments
- Add `///` for public API documentation
- Prefer `Result<T, E>` over panics for error handling
- Use the `?` operator for error propagation

### TypeScript

- Use `camelCase` for variables and functions
- Use `PascalCase` for classes and interfaces
- Add JSDoc comments for exported functions
- Prefer `const` over `let` where possible

### Formatting

```bash
# Format Rust code
cd native && cargo fmt

# Format TypeScript code
pnpm format:fix

# Check formatting
pnpm format:check
```

## 🧪 Testing

### Running Tests

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run tests with coverage
pnpm test:coverage
```

### Test Coverage

Target: >70% coverage
- Lines: 70%
- Branches: 70%
- Functions: 70%
- Statements: 70%

### Writing Tests

Tests should:
- Verify the expected behavior
- Test error conditions
- Cover edge cases
- Include examples in comments when needed

## 🚀 Building Native Module

### Development Build

```bash
# Build for current platform (faster)
cd native && pnpm exec napi build --platform --release

# Build for all platforms (for release)
pnpm exec napi build --platform --release
```

### Release Build

```bash
# Build with release optimizations
cd native && pnpm exec napi build --platform --release

# Verify binaries were created
ls -la *.node
```

## 🔒 Security Guidelines

### Input Validation

- Always validate user input (size, format, content)
- Use `validate_path()` for file paths
- Set appropriate size limits for all operations
- Check for null bytes and invalid characters

### Cryptographic Practices

- Use the provided encryption functions (AES-256-GCM, Argon2)
- Never hardcode keys or secrets
- Always generate nonces randomly
- Never reuse nonces with the same key
- Use secure random number generation (OsRng)

### Error Handling

- Use `Result<T, E>` types for recoverable errors
- Convert panics to appropriate errors
- Provide meaningful error messages
- Log errors appropriately (not expose sensitive data)

## 📚 Documentation

### Adding Features

When adding new features:

1. Update [USER_GUIDE.md](./USER_GUIDE.md) with usage examples
2. Update [API Reference](./API.md) if applicable
3. Add tests for new functionality
4. Update [CHANGELOG](../CHANGELOG.md) with version and changes

### Writing Examples

Examples should be:
- Clear and concise
- Show error handling
- Include necessary imports
- Comment what the example demonstrates

### Updating CHANGELOG

Format:
```markdown
### Added
- New feature description

### Fixed
- Bug fix description

### Changed
- Breaking change description

## 🐛 Reporting Issues

### Security Issues

For security vulnerabilities, **do not open public issues.** Email:
- security@openclaw.ai

Include:
- Vulnerability description
- Steps to reproduce
- Impact assessment
- Suggested fix

### Bug Reports

For bugs:
- Use GitHub issues with appropriate labels
- Search existing issues before creating new ones
- Include minimal reproduction steps

### Issue Labels

- `bug`: Confirmed bugs
- `security`: Security issues
- `enhancement`: Feature requests
- `documentation`: Docs improvements
- `good first issue`: For first-time contributors

## 📦 Pull Request Process

### Before Submitting

1. Run all tests: `pnpm test`
2. Format code: `pnpm format:check`
3. Check clippy warnings: `cd native && cargo clippy`
4. Update documentation if needed
5. Ensure CHANGELOG is updated

### PR Description

```markdown
## Description
Brief description of changes

## Type of Change
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `refactor`: Code refactoring
- `test`: Test additions
- `perf`: Performance improvements

## Breaking Changes
List any breaking changes with migration instructions

## Checklist
- [ ] Tests pass
- [ ] Documentation updated
- [ ] CHANGELOG updated
- [ ] No clippy warnings
- [ ] Format check passes
```

### Code Review Guidelines

- Keep PRs focused and small when possible
- One feature per PR
- Include tests for new functionality
- Respond to review feedback promptly

## 📞 Getting Help

### Questions?

- Ask in GitHub issues
- Join [OpenClaw Discord](https://discord.gg/openclaw)
- Check existing documentation first

### Resources

- [User Guide](./USER_GUIDE.md)
- [Developer Guide](./DEVELOPER_GUIDE.md)
- [API Reference](./API.md)
- [CHANGELOG](../CHANGELOG.md)
- [Security Policy](./SECURITY.md)

## 🙏 License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to the Rust plugin! 🚀
