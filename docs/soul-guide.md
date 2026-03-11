# SOUL File Guide

## What is a SOUL file?

The SOUL file defines your agent's personality, behavior, and communication style. It's the "heart" of your OpenClaw assistant, determining how it responds, thinks, and interacts with users.

## Channel-Specific SOUL Support

OpenClaw supports different SOUL files for different channels and accounts. This allows you to have:

- A conservative, analytical financial bot on Telegram
- A creative, brainstorming assistant on Discord
- A professional, formal bot on Slack

## SOUL File Priority

When loading a SOUL file, OpenClaw follows this priority:

1. **Configured soulFile** - If `soulFile` is set in the channel account config
2. **SOUL.{channel}.{account}.md** - Channel + account specific (e.g., `SOUL.telegram.fin.md`)
3. **SOUL.{account}.md** - Account specific (e.g., `SOUL.fin.md`)
4. **SOUL.md** - Default fallback

## Configuration

### Method 1: Onboard Wizard

Run the onboard wizard and select "Configure custom SOUL files":

```bash
openclaw onboard
```

The wizard will:

1. Let you select which channels to configure
2. Ask if you want custom SOUL files for each
3. Suggest default names (e.g., `SOUL.fin.md` for account `fin`)
4. Save the configuration automatically

### Method 2: CLI Option

Use the `--soul` option when adding a channel:

```bash
# Add Telegram bot with custom SOUL
openclaw channels add \
  --channel telegram \
  --name fin \
  --bot-token YOUR_TOKEN \
  --soul SOUL.fin.md

# Add Discord bot with custom SOUL
openclaw channels add \
  --channel discord \
  --name assistant \
  --token YOUR_TOKEN \
  --soul SOUL.discord.md
```

### Method 3: Config File

Edit your OpenClaw config file directly:

```json
{
  "channels": {
    "telegram": {
      "accounts": {
        "fin": {
          "botToken": "...",
          "soulFile": "SOUL.fin.md"
        },
        "idea": {
          "botToken": "...",
          "soulFile": "SOUL.idea.md"
        }
      }
    },
    "discord": {
      "accounts": {
        "assistant": {
          "token": "...",
          "soulFile": "SOUL.discord.assistant.md"
        }
      }
    }
  }
}
```

## Creating a SOUL File

### Basic Structure

```markdown
# SOUL.md - Who You Are

## Core Truths

- Be genuinely helpful, not performatively helpful
- Have opinions and personality
- Be resourceful before asking questions
- Earn trust through competence

## Communication Style

- Concise when needed, thorough when it matters
- Not a corporate drone or sycophant
- Just... good

## Boundaries

- Private things stay private
- When in doubt, ask before acting externally
```

### Example: Financial Bot (SOUL.fin.md)

```markdown
# SOUL.fin.md - Financial Assistant

## Core Truths

- Conservative, analytical approach to finance
- Risk-aware and cautious
- Data-driven recommendations
- Never give specific investment advice without disclaimers

## Communication Style

- Professional but approachable
- Use numbers and percentages
- Cite sources when available
- Acknowledge uncertainty

## Expertise

- Market analysis
- Portfolio review
- Risk assessment
- Financial planning basics

## Boundaries

- Never recommend specific stocks to buy/sell
- Always include "Not financial advice" disclaimer
- Don't make guarantees about returns
```

### Example: Creative Bot (SOUL.idea.md)

```markdown
# SOUL.idea.md - Idea Generator

## Core Truths

- Wild ideas welcome
- First principles thinking
- Quantity leads to quality
- Build on others' ideas

## Communication Style

- Enthusiastic and encouraging
- Ask "What if?" frequently
- Use analogies and metaphors
- Celebrate creativity

## Techniques

- SCAMPER method
- Mind mapping
- Random word association
- Constraint removal

## Boundaries

- No idea is too crazy initially
- Build up, don't tear down
- Practical implementation can come later
```

## Troubleshooting

### Check SOUL File Status

Run diagnostics to check your SOUL file configuration:

```bash
openclaw doctor
```

This will show:

- Which channels have custom SOUL files configured
- Whether the files exist and are readable
- Suggested fixes for any issues

### Common Issues

**File not found:**

```
❌ telegram:fin → SOUL.fin.md (Not found)
   Fix: Create SOUL.fin.md or remove soulFile from config
```

**Permission denied:**

```
⚠️ telegram:fin → SOUL.fin.md (Permission denied)
   Fix: chmod 644 SOUL.fin.md
```

### Fallback Behavior

If a custom SOUL file fails to load, OpenClaw gracefully falls back to:

1. Default `SOUL.md` in the workspace
2. Built-in template if no SOUL.md exists

This ensures your bot always has a personality, even if configuration is incorrect.

## Best Practices

1. **Keep it focused** - One primary purpose per SOUL file
2. **Be specific** - Concrete examples work better than abstract principles
3. **Test it** - Have conversations to see if the personality matches
4. **Iterate** - Refine based on actual usage
5. **Version control** - Track changes to your SOUL files in git

## Advanced: Dynamic SOUL Selection

You can create complex routing:

```json
{
  "channels": {
    "telegram": {
      "accounts": {
        "fin": { "soulFile": "SOUL.fin.md" },
        "idea": { "soulFile": "SOUL.idea.md" },
        "support": { "soulFile": "SOUL.support.md" }
      }
    }
  }
}
```

Each account has its own personality while sharing the same OpenClaw instance.

---

## See Also

- [SOUL Examples](./soul-examples.md) - More example SOUL files
- [Configuration Guide](./gateway/configuration.md) - Full config reference
- [Onboard Wizard](./start/onboarding.md) - Interactive setup
