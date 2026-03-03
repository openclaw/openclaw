# ECC Integration Setup Guide

Complete setup guide for integrating Everything Claude Code (ECC) with OpenClaw.

## Prerequisites

- **Node.js** 20+ (recommended: 22 LTS)
- **OpenClaw** 2026.3.0+
- **Git** (for cloning ECC patterns)

## Quick Start

### 1. Install the Extension

```bash
# From the OpenClaw repository root
cd extensions/ecc-integration
npm install
```

### 2. Build the Extension

```bash
npm run build
```

### 3. Configure OpenClaw

Add the ECC configuration to your OpenClaw setup:

```bash
# Copy the config file
cp openclaw.config.ts ~/.openclaw/config/ecc.config.ts

# Or merge with existing config
openclaw config set ecc.enabled true
```

### 4. Verify Installation

```bash
# Check ECC integration status
openclaw governance status

# You should see:
# 📋 Governance Status
# ===================
# Active Rules: 5
# Total Agents: 4
# Total Tasks: 0
```

## Configuration Options

### Core Rules (Required)

Your three fundamental rules are enforced by default:

1. **Rules > Freedom** (`requireRuleValidation: true`)
   - All agent actions validated against governance rules
   - Cannot be disabled

2. **One Agent/One Task** (`enforceSingleTaskPerAgent: true`)
   - Each agent handles exactly one task
   - Reassignment requires task completion

3. **Claude Code Integration** (`requireECCSkills: true`)
   - All agents use ECC skill profiles
   - Expert knowledge always available

### Agent Pool Configuration

```typescript
// ~/.openclaw/config/ecc.config.ts
export default {
  ecc: {
    agents: {
      // Auto-create agents on startup
      autoInitialize: true,
      
      // Which agent types to create
      defaultTypes: ['architect', 'developer', 'reviewer', 'security'],
      
      // Max concurrent agents per type
      maxAgentsPerType: 3,
      
      // Auto-scale when busy
      autoScaling: true
    }
  }
};
```

### Security Settings

```typescript
export default {
  ecc: {
    security: {
      enabled: true,
      scanOnChange: true,
      blockOnCritical: true,
      
      // Security levels by agent type
      levels: {
        security: 'maximum',    // All checks
        architect: 'enhanced',  // Standard + architecture
        developer: 'enhanced',  // Standard + code quality
        reviewer: 'enhanced',   // Standard + review checks
        devops: 'enhanced',     // Standard + infrastructure
        learning: 'standard'    // Basic checks
      }
    }
  }
};
```

### Learning Configuration

```typescript
export default {
  ecc: {
    learning: {
      enabled: true,
      
      // Only create instincts with 70%+ confidence
      minConfidenceThreshold: 0.7,
      
      // Max 100 instincts per agent (auto-prunes old)
      maxInstinctsPerAgent: 100,
      
      // Evolve skills every hour
      skillEvolutionIntervalMs: 3600000,
      
      // Export learning data daily
      autoExport: {
        enabled: true,
        intervalMs: 86400000,
        path: '~/.openclaw/learning'
      }
    }
  }
};
```

## Usage Examples

### Creating a Task

```bash
# Basic task
openclaw agent-task "Refactor authentication module"

# With options
openclaw agent-task "Fix API vulnerability" \
  --description "Security issue in auth endpoint" \
  --priority critical \
  --type security

# Output:
# ✅ Task submitted: task-1234567890-abc123
#    Title: Fix API vulnerability
#    Priority: critical
#    Preferred Agent: security
```

### Checking Agent Status

```bash
openclaw agent-status

# Output:
# 🤖 Agents
# =========
# agent-123456789 (security): working - working on "Fix API vulnerability"
# agent-987654321 (developer): idle
# agent-456789123 (architect): idle
# agent-789123456 (reviewer): idle
```

### Security Scanning

```bash
# Scan a file
openclaw security scan src/auth.ts

# Scan a directory
openclaw security scan ./src

# Output includes:
# 🔍 Scanning ./src...
# # Security Scan Report
# **Status:** ❌ FAILED
# ## Summary
# - Critical: 1
# - High: 2
# - Total: 3
```

### Skill Creation

```bash
# Create skill from patterns
openclaw skill create "api-error-handling" \
  --patterns "try-catch,error-response,logging"

# Output to file
openclaw skill create "api-error-handling" \
  --patterns "try-catch,error-response,logging" \
  --output skills/api-error-handling.md
```

### Viewing Instincts

```bash
# View agent's learned instincts
openclaw agent instincts agent-123456789

# Output:
# 🧠 Instincts for agent-123456789
# ========================
# 
# Task "Fix API vulnerability" completed successfully
#   Confidence: 90.0%
#   Source: task-completion
#   Created: 2026/03/03
```

## Best Practices

### 1. Start with Default Configuration

The defaults are optimized for most use cases:
- 4 agent types with auto-scaling
- Enhanced security for all agents
- Learning enabled with 70% confidence threshold

### 2. Monitor Learning Progress

```bash
# Check learning stats daily
openclaw learning status
```

### 3. Regular Security Scans

```bash
# Add to your CI/CD pipeline
openclaw security scan . || exit 1
```

### 4. Export Learning Data

```bash
# Weekly backup
openclaw learning export learning-backup-$(date +%Y%m%d).json
```

## Troubleshooting

### Issue: Agents not auto-creating

**Solution**: Check configuration
```bash
openclaw config get ecc.agents.autoInitialize
# Should be: true

# If false, set it:
openclaw config set ecc.agents.autoInitialize true
```

### Issue: Security scan blocking tasks

**Solution**: Check security level
```bash
# View current security config
openclaw governance rules

# If too strict, adjust per-agent:
openclaw config set ecc.security.levels.developer standard
```

### Issue: Learning not recording

**Solution**: Verify learning is enabled
```bash
openclaw config get ecc.learning.enabled
# Should be: true

# Check instinct count
openclaw agent instincts <agent-id>
```

### Issue: Task assignment failing

**Solution**: Check agent availability
```bash
# View all agents
openclaw agent list

# Check for stuck agents
openclaw governance status

# If agents stuck, system will auto-heal after 5 minutes
# Or manually reset:
openclaw agent reset <agent-id>
```

## Advanced Configuration

### Custom Governance Rules

Add custom rules in your config:

```typescript
export default {
  ecc: {
    governance: {
      customRules: [
        {
          id: 'custom-001',
          name: 'Require Tests',
          description: 'All code changes must include tests',
          priority: 'high',
          condition: 'task.type == "code-change"',
          action: 'requireTestFiles()',
          enabled: true
        }
      ]
    }
  }
};
```

### Custom Agent Types

Extend with your own agent types:

```typescript
// In your plugin initialization
const customAgent = system.createAgent('custom-type');
system.registerExecutor('custom-type', async (task, agent, context) => {
  // Custom execution logic
  return { success: true, result: 'completed' };
});
```

### Webhook Integration

```typescript
export default {
  ecc: {
    webhooks: {
      onTaskComplete: 'https://your-app.com/webhooks/task-complete',
      onSecurityFinding: 'https://your-app.com/webhooks/security',
      onSkillEvolution: 'https://your-app.com/webhooks/skill'
    }
  }
};
```

## Integration with Mobile App

When your Mission Control mobile app is ready:

```typescript
// Connect to OpenClaw gateway
const client = new OpenClawClient({
  host: 'localhost',
  port: 18789,
  ecc: true  // Enable ECC features
});

// Real-time updates
client.on('agent-update', (update) => {
  // Update mobile UI
});

// Submit task from mobile
await client.ecc.submitTask({
  title: 'Fix login bug',
  priority: 'high',
  agentType: 'developer'
});
```

## Next Steps

1. ✅ **ECC Integration** - Complete
2. 🔄 **Mission Control Web** - Design complete, implementation ready
3. 🔄 **Mobile App** - Architecture complete, development ready
4. ⏳ **Advanced Features** - Ready for custom extensions

## Support

- **Documentation**: See `docs/` directory
- **Issues**: Report at https://github.com/openclaw/openclaw/issues
- **Discussions**: https://github.com/openclaw/openclaw/discussions

---

**Remember**: Your three core rules are always enforced:
1. **Rules > Freedom** - Governed behavior
2. **One Agent/One Task** - Clear accountability
3. **Claude Code Integration** - Expert knowledge
