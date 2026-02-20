# OpenClaw Self-Evolution System

OpenClaw now includes self-improvement and self-repair capabilities inspired by SakanaAI's research on evolutionary model merging and self-adapting AI systems.

## Overview

This system provides three main capabilities:

1. **Self-Repair**: Automatically detects and fixes configuration issues
2. **Self-Evolution**: Evolutionary optimization of configuration parameters
3. **Health Monitoring**: Continuous health checks of the system

## Commands

### Health Check

```bash
openclaw evo health
```

Runs comprehensive health checks on your configuration including:

- Model configuration validation
- Provider availability
- Memory settings
- Timeout settings
- Context pruning configuration

### Auto-Repair

```bash
openclaw evo repair
```

Automatically repairs configuration issues:

- Adds fallback models for reliability
- Enables memory search if disabled
- Configures optimal timeout settings
- Enables context pruning

### Evolutionary Optimization

```bash
openclaw evo evolve -g 20 -p 10
```

Runs evolutionary optimization to find the best configuration parameters:

- `-g, --generations`: Number of evolution generations (default: 10)
- `-p, --population`: Population size (default: 10)

The evolutionary engine:

1. Creates a population of configuration variations
2. Evaluates each individual based on performance metrics
3. Applies mutations (provider priority, memory weight, etc.)
4. Selects the best performers through tournament selection
5. Crossover combines traits from top performers
6. Saves the best configuration automatically

### Status

```bash
openclaw evo status
```

Shows the current status of the self-management system.

## How It Works

### Evolutionary Algorithm

Inspired by SakanaAI's Evolutionary Model Merge paper, the system uses:

- **Population-based search**: Multiple configuration variants compete
- **Tournament selection**: Best performers selected through competition
- **Mutation operators**:
  - Provider priority shuffling
  - Model alias optimization
  - Streaming settings
  - Memory weight tuning
  - Context pruning configuration
  - Thinking mode selection
- **Fitness evaluation**: Based on response time, error rate, memory usage, task completion

### Self-Repair Logic

The repair system automatically detects and fixes:

- Missing fallback models (adds `ollama/rnj-1-instruct`)
- Disabled memory search (enables for better context)
- Suboptimal timeout values (sets to 60s default)
- Missing context pruning (enables cache-ttl mode)

## Configuration

The system reads from and writes to:

- `~/.openclaw/agents/default/agent/models.json`

## Example Usage

```bash
# Check current health
openclaw evo health

# Auto-fix any issues
openclaw evo repair

# Run optimization with 20 generations
openclaw evo evolve -g 20 -p 15

# Check status
openclaw evo status
```

## References

This implementation is inspired by:

- **SakanaAI Evolutionary Model Merge**: https://github.com/sakanaai/evolutionary-model-merge
- **Paper**: "Evolutionary Optimization of Model Merging Recipes" (Nature Machine Intelligence)
- **ShinkaEvolve**: Evolutionary code optimization framework

## Future Enhancements

Planned features:

- Multi-objective optimization (speed vs quality)
- Model merging capabilities (SakanaAI-style)
- Automated skill evolution
- Adaptive parameter tuning based on usage patterns
