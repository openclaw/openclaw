# Contributing to OpenClaw Evolution Framework

Thank you for your interest in contributing! This framework is built by the community, for the community.

## 🌟 Ways to Contribute

### 1. Share Your Evolution Results

Run the framework and share interesting insights:

- **Where**: Create a PR to `examples/community/`
- **What to include**:
  - Anonymized exploration outputs (remove personal info)
  - Your configuration (`evolution-config.yaml`)
  - Summary of key insights
  - Lessons learned

**Example structure**:
```
examples/community/your-name/
├── README.md (summary & lessons)
├── config.yaml (your configuration)
└── rounds/
    ├── round-05-interesting-insight.md
    └── round-23-breakthrough-moment.md
```

### 2. Improve Safety Mechanisms

Help make evolution sessions safer and more reliable:

- Better stop conditions
- HITL checkpoint patterns
- Error recovery strategies
- Resource monitoring

### 3. Add Exploration Templates

Create reusable exploration templates for common use cases:

- Research assistant patterns
- Product development workflows
- Learning companion scripts
- Creative exploration prompts

### 4. Build Tooling

Enhance the framework with developer tools:

- Visual dashboard for monitoring
- Export to other formats (Obsidian, Notion, Roam)
- Analytics and insight extraction
- Integration with external tools

### 5. Documentation

- Improve README clarity
- Add tutorials and guides
- Translate to other languages
- Document edge cases and solutions

## 🔧 Development Setup

### Prerequisites

```bash
node >= 18.0.0
npm >= 9.0.0
openclaw >= 2026.2.0
```

### Setup

```bash
# Fork the openclaw repository (if not already forked)
# Clone your fork
git clone https://github.com/your-username/openclaw.git
cd openclaw

# Create a branch in examples/community/
git checkout -b feature/evolution-your-contribution
```

## 📝 Pull Request Process

### 1. Fork & Branch

```bash
git checkout -b feature/your-feature-name
```

### 2. Make Changes

- Keep commits atomic and well-described
- Follow existing code style
- Add tests if applicable
- Update documentation

### 3. Test

Before submitting:

```bash
# Verify your changes don't break existing examples
cd examples/community/evolution-framework

# Test the config is valid YAML
python3 -c "import yaml; yaml.safe_load(open('evolution-config.example.yaml'))"

# Verify JSON files are valid
python3 -m json.tool cron-evolution-job.json > /dev/null
```

### 4. Submit PR

- Clear title describing the change
- Description explaining why and what
- Link to related issues
- Screenshots/examples if applicable

### PR Review Process

1. **Automated checks** (if configured)
2. **Community review** (1-2 reviewers)
3. **Maintainer approval**
4. **Merge** (squash and merge)

## 🎨 Style Guidelines

### Configuration Files

- Use YAML for configs (not JSON for user-facing files)
- Include comments explaining each section
- Provide sensible defaults
- Use consistent indentation (2 spaces)

### Markdown Documentation

- Use ATX-style headers (`#` not underlines)
- Include code blocks with language hints
- Add examples for complex concepts
- Keep line length reasonable (~80-100 chars)

### Code (if contributing scripts)

- Follow JavaScript Standard Style
- Use async/await over callbacks
- Add JSDoc comments for functions
- Handle errors gracefully

## 🚫 What NOT to Contribute

Please avoid:

- **Personal information** in examples
  - Remove names, locations, companies
  - Anonymize user data
  - Strip API keys and secrets

- **Copyrighted content**
  - Don't copy-paste from papers without permission
  - Use your own words
  - Link to sources instead

- **Dangerous configurations**
  - No infinite loops without stop conditions
  - No excessive API usage
  - No privacy-violating data collection

## 🏆 Recognition

Contributors will be recognized in:

- `CONTRIBUTORS.md` file
- Release notes
- Project README

## 📜 Code of Conduct

Be respectful, collaborative, and constructive:

- **Be kind**: Assume good intentions
- **Be helpful**: Share knowledge generously
- **Be honest**: Admit mistakes, learn together
- **Be inclusive**: Welcome all backgrounds

## 🤔 Questions?

- **General questions**: Open a Discussion
- **Bug reports**: Open an Issue
- **Feature requests**: Open an Issue with `[Feature]` prefix
- **Security concerns**: Email maintainers privately

## 📊 Priority Areas

We especially welcome contributions in:

1. **Safety & reliability** (HITL patterns, error handling)
2. **Templates & patterns** (reusable exploration workflows)
3. **Visualization** (dashboards, progress tracking)
4. **Documentation** (tutorials, case studies)
5. **Testing** (automated testing, validation)

## 🙏 Thank You!

Every contribution makes the framework better for everyone. Whether you fix a typo or build a major feature, your effort is appreciated.

**Happy evolving!** 🌳
