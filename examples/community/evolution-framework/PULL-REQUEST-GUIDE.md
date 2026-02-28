# Pull Request Guide - Submit to OpenClaw Official Repository

## Overview

This guide walks you through submitting the Evolution Framework as a contribution to the official OpenClaw repository.

## Option 1: Community Examples (Recommended for First PR)

Submit to `examples/community/` directory.

### Step 1: Fork OpenClaw Repository

1. Go to https://github.com/openclaw/openclaw
2. Click "Fork" button (top right)
3. Clone your fork:

```bash
git clone https://github.com/YOUR-USERNAME/openclaw.git
cd openclaw
```

### Step 2: Create Feature Branch

```bash
git checkout -b feature/evolution-framework-example
```

### Step 3: Add Evolution Framework

```bash
# Create community examples directory if it doesn't exist
mkdir -p examples/community/evolution-framework

# Copy our framework files
cp -r ~/.openclaw/workspace/openclaw-evolution-framework/* examples/community/evolution-framework/

# Or create a symlink (if you want to keep developing)
# ln -s ~/.openclaw/workspace/openclaw-evolution-framework examples/community/evolution-framework
```

### Step 4: Create a Summary README

Create `examples/community/evolution-framework/SUMMARY.md`:

```markdown
# Evolution Framework - Community Example

**Author**: @YOUR-GITHUB-USERNAME  
**Date**: 2026-02-28  
**OpenClaw Version**: 2026.2.12+

## What This Is

An autonomous continuous learning framework that enables OpenClaw agents to:
- Run 40-60 exploration rounds overnight
- Self-trigger next rounds automatically
- Rotate across multiple themes
- Generate structured insights

## Real Results

59-round overnight test:
- 9 hours autonomous operation
- ~200,000 words of insights
- 98% self-trigger success rate
- 5 themes with balanced coverage

## Key Features

- **Safety**: HITL checkpoints, time limits, emergency stops
- **Flexibility**: Configurable themes and exploration depth
- **Production-Ready**: Validated with real overnight runs

## Quick Start

See [README.md](README.md) for full documentation.

```bash
cp evolution-config.example.yaml evolution-config.yaml
openclaw cron add --file cron-evolution-job.json
openclaw cron run evolution-fast-loop
```

## Files

- `README.md` - Complete documentation
- `QUICKSTART.md` - 5-minute setup guide
- `evolution-config.example.yaml` - Production config
- `cron-evolution-job.json` - Cron task definition
- `examples/` - 3 real anonymized outputs

## Use Cases

- Research assistant (overnight literature reviews)
- Product development (explore ideas while you sleep)
- Learning companion (continuous knowledge building)

## Community

Standalone repo: https://github.com/YOUR-USERNAME/openclaw-evolution-framework

Issues and discussions welcome!
```

### Step 5: Commit Changes

```bash
git add examples/community/evolution-framework/
git commit -m "Add Evolution Framework community example

- Autonomous 40-60 round exploration sessions
- Production-ready with safety mechanisms
- Validated with 59-round overnight test
- Complete documentation and examples"
```

### Step 6: Push to Your Fork

```bash
git push origin feature/evolution-framework-example
```

### Step 7: Create Pull Request

1. Go to your fork: `https://github.com/YOUR-USERNAME/openclaw`
2. Click "Compare & pull request" button
3. Fill in PR details:

**Title**:
```
Add Evolution Framework - Autonomous Continuous Learning Example
```

**Description**:
```markdown
## Summary

Adds the Evolution Framework to community examples - an autonomous continuous learning system for OpenClaw agents.

## What This Adds

A complete framework for running autonomous exploration sessions:
- 40-60 rounds overnight (validated with real 59-round test)
- Self-triggering mechanism (98% success rate)
- Multi-theme rotation (5 default themes)
- Safety mechanisms (HITL, time limits, emergency stops)

## Files Added

- `examples/community/evolution-framework/` - Complete framework
  - README.md - Full documentation
  - QUICKSTART.md - 5-minute setup
  - evolution-config.example.yaml - Production config
  - examples/ - 3 anonymized real outputs
  - CONTRIBUTING.md, LICENSE (MIT)

## Testing

- ✅ 59-round overnight run (9 hours)
- ✅ ~200,000 words of insights generated
- ✅ 98% self-trigger success rate
- ✅ All safety mechanisms validated

## Real Results

**Theme Distribution**:
- Domain Expertise: 25%
- System Thinking: 20%
- User Understanding: 20%
- Free Exploration: 17%
- Practical Application: 17%

**Example Outputs**:
- Round 14: AI's "System 1/2" thinking
- Round 42: Emotion architecture for AI
- Round 58: Medical LLMs cognitive blind spots

See `examples/` directory for full outputs.

## Use Cases

- **Research Assistant**: Overnight literature reviews
- **Product Development**: Explore product ideas autonomously
- **Learning Companion**: Continuous knowledge building

## Community Value

- **Demonstrates**: Long-running autonomous agent capabilities
- **Best Practices**: Self-triggering + HITL + safety mechanisms
- **Reusable**: Works for any domain (just configure themes)

## Checklist

- [x] Follows OpenClaw coding standards
- [x] Includes complete documentation
- [x] Tested in production (59-round run)
- [x] MIT License
- [x] No personal/sensitive information
- [x] Examples are anonymized

## Standalone Repository

Also available as standalone repo for easier discovery:
https://github.com/YOUR-USERNAME/openclaw-evolution-framework

## Author

@YOUR-GITHUB-USERNAME

## Questions?

Happy to answer any questions or make requested changes!
```

4. Click "Create pull request"

## Option 2: Core Examples (Advanced)

If maintainers prefer, this could go into `examples/evolution-framework/` instead of `examples/community/`.

Same process, but target directory is `examples/evolution-framework/`.

## Option 3: Documentation Contribution

Could also add a guide to official docs:

```
docs/guides/autonomous-exploration.md
docs/examples/evolution-framework.md
```

## After PR is Submitted

### Monitor for Feedback

- Check GitHub notifications
- Respond to review comments
- Make requested changes if needed

### Update Your Branch

If maintainers request changes:

```bash
# Make changes to files
git add .
git commit -m "Address review feedback: [specific change]"
git push origin feature/evolution-framework-example
```

The PR will update automatically.

### When PR is Merged

1. **Celebrate!** 🎉
2. **Update your README** to link to official repo
3. **Announce** on Discord/Twitter
4. **Write blog post** mentioning the contribution

## Tips for Successful PR

### Do's

- ✅ Follow existing code/doc style
- ✅ Provide complete documentation
- ✅ Include real test results
- ✅ Respond quickly to feedback
- ✅ Be respectful and collaborative

### Don'ts

- ❌ Include personal information
- ❌ Add dependencies without discussion
- ❌ Make unrelated changes
- ❌ Ignore review feedback
- ❌ Be defensive about critique

## Alternative: Discuss First

Consider opening a Discussion or Issue first:

**Discussion Topic**:
```
Evolution Framework - Autonomous Continuous Learning for OpenClaw

I've built a framework for running autonomous exploration sessions 
(40-60 rounds overnight). Would this be valuable as a community example?

Real results: 59-round test, 200K words of insights, 98% self-trigger success.

Repo: https://github.com/YOUR-USERNAME/openclaw-evolution-framework

Happy to contribute if this aligns with OpenClaw's direction!
```

This allows maintainers to provide guidance before you invest time in the PR.

## Questions?

- OpenClaw Discord: https://discord.com/invite/clawd
- GitHub Discussions: https://github.com/openclaw/openclaw/discussions

---

**Good luck with your contribution!** 🚀
