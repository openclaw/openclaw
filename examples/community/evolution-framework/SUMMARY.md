# Evolution Framework

**Autonomous continuous learning framework for OpenClaw agents**

## Overview

The Evolution Framework enables OpenClaw agents to run 40-60 exploration rounds autonomously overnight, generating deep insights across multiple domains.

## Key Features

- **Autonomous Operation**: Self-triggering mechanism with 98% reliability
- **Safety Mechanisms**: HITL checkpoints, time limits, emergency stops
- **Multi-Theme Support**: Rotate across 5 exploration themes
- **Production-Ready**: Validated with 59-round overnight test

## Quick Start

```bash
cd examples/community/evolution-framework
./setup.sh
openclaw cron run evolution-fast-loop
```

See [README.md](README.md) for complete documentation.

## Real Results

Our production test completed:
- 59 exploration rounds
- ~200,000 words of insights
- 9 hours autonomous operation
- 98% self-trigger success rate

## Examples

See [examples/](examples/) for three anonymized real exploration rounds:
- Round 14: AI's System 1/2 thinking patterns
- Round 42: Functional emotion architecture for AI
- Round 58: 10 cognitive blind spots in Medical LLMs

## Repository

This example is also available as a standalone repository:
https://github.com/TerryFYL/openclaw-evolution-framework

## License

MIT License - See [LICENSE](LICENSE)
