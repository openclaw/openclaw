# OpenClaw Evolution Framework

> **Autonomous Continuous Learning for AI Agents**

A production-ready framework for running autonomous exploration sessions with OpenClaw agents. Enables AI agents to continuously explore, learn, and evolve through structured self-directed sessions.

## 🌟 What is This?

The Evolution Framework allows your OpenClaw agent to:

- **Run autonomous exploration sessions** (overnight, weekends, or during work hours)
- **Self-trigger iterations** with configurable intervals (default: 8 minutes)
- **Explore across multiple themes** with automatic rotation
- **Generate structured insights** saved as markdown artifacts
- **Stop automatically** at configured endpoints with summary reports

**Real Results**: In a 9-hour overnight run, our test agent completed 59 exploration rounds, generating ~200,000 words of deep analysis across 5 theme areas.

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install -g openclaw@latest
```

### 2. Clone & Configure

```bash
# Clone this repository
git clone https://github.com/your-org/openclaw-evolution-framework.git
cd openclaw-evolution-framework

# Copy example config
cp evolution-config.example.yaml evolution-config.yaml

# Edit with your exploration themes
nano evolution-config.yaml
```

### 3. Set Up Cron Job

```bash
# Add the evolution cron job
openclaw cron add --file cron-evolution-job.json

# Verify it's scheduled
openclaw cron list
```

### 4. Start Evolution

The cron job will trigger automatically at the scheduled time, or run immediately:

```bash
openclaw cron run evolution-fast-loop
```

## 📋 How It Works

```
┌─────────────────────────────────────────────────────┐
│  Cron Trigger (every 8 min)                         │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│  1. Check Time (stop if past deadline)              │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│  2. Select Theme (rotate from config)                │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│  3. Deep Exploration (8-15 min)                      │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│  4. Save Insights (markdown file)                    │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│  5. Self-Trigger Next Round (exec background)        │
└─────────────────────────────────────────────────────┘
```

## 🎯 Configuration

### Evolution Config (`evolution-config.yaml`)

```yaml
# Exploration themes (agent will rotate through these)
themes:
  - name: "Domain Expertise"
    description: "Deep dive into domain-specific knowledge"
    weight: 30
  
  - name: "System Thinking"
    description: "Architecture, patterns, and design principles"
    weight: 25
  
  - name: "User Understanding"
    description: "User needs, pain points, and behavior patterns"
    weight: 20
  
  - name: "Free Exploration"
    description: "Follow curiosity, connect ideas across domains"
    weight: 15
  
  - name: "Practical Application"
    description: "MVPs, monetization, and real-world execution"
    weight: 10

# Safety & control
safety:
  max_duration_hours: 10
  interval_minutes: 8
  night_mode:
    enabled: true
    quiet_hours: "23:00-07:00"
    silent_delivery: true
  
  hitl_checkpoints:
    - round: 20
      pause: true
      message: "20 rounds complete. Continue? (yes/no)"
    
    - round: 40
      pause: true
      message: "40 rounds complete. Continue? (yes/no)"

# Output
output:
  directory: "memory/evolution"
  format: "markdown"
  include_metadata: true
  summary_every_n_rounds: 10
```

### Cron Job (`cron-evolution-job.json`)

```json
{
  "name": "evolution-fast-loop",
  "schedule": {
    "kind": "every",
    "everyMs": 480000
  },
  "sessionTarget": "isolated",
  "payload": {
    "kind": "agentTurn",
    "message": "Run evolution exploration following evolution-config.yaml",
    "timeoutSeconds": 900
  },
  "delivery": {
    "mode": "announce",
    "channel": "telegram"
  }
}
```

## 📊 Example Output

After a 9-hour overnight run, you'll get:

```
memory/evolution/
├── round-01-20260227-2250.md    # First exploration
├── round-02-20260227-2301.md
├── ...
├── round-59-20260228-0754.md    # Final exploration
├── summary-20260228-morning.md  # Auto-generated summary
└── FINAL-REPORT-20260228.md     # Complete analysis
```

### Sample Exploration Output

See `examples/` directory for real (anonymized) outputs:

- `examples/round-14-ai-intuition.md` - Exploring AI's "System 1/2" thinking
- `examples/round-42-emotion-architecture.md` - Designing emotion systems for AI
- `examples/round-58-medical-llm-blind-spots.md` - 10 cognitive blind spots in Medical AI

## 🛡️ Safety Features

### 1. Automatic Stop Conditions

- Time deadline (default: 8 hours)
- Maximum rounds (configurable)
- Manual stop signal (via cron disable)

### 2. HITL (Human-in-the-Loop) Checkpoints

```yaml
hitl_checkpoints:
  - round: 20
    pause: true
    message: "Checkpoint: 20 rounds complete. Review and approve to continue."
```

Agent will pause and wait for human approval before continuing.

### 3. Night Mode (Silent Operation)

```yaml
night_mode:
  enabled: true
  quiet_hours: "23:00-07:00"
  silent_delivery: true  # No notifications during night
```

### 4. Theme Guardrails

Prevent exploration from going off-track:

```yaml
themes:
  - name: "Domain Expertise"
    guardrails:
      - "Stay within defined domain boundaries"
      - "Use web_search for fact-checking"
      - "Avoid speculation without evidence"
```

## 🎓 Use Cases

### 1. Research Assistant

Run overnight explorations on research topics:

```yaml
themes:
  - "Literature Review: Meta-analysis methodologies"
  - "Technical Deep Dive: Statistical validation techniques"
  - "Application Design: Research automation tools"
```

### 2. Product Development

Explore product ideas while you sleep:

```yaml
themes:
  - "User Pain Points: [Your Domain]"
  - "Competitive Analysis: Feature gaps"
  - "MVP Design: Minimum viable architecture"
  - "Go-to-Market: Positioning and messaging"
```

### 3. Learning Companion

Continuous learning on any topic:

```yaml
themes:
  - "Fundamentals: Core concepts and principles"
  - "Advanced Patterns: Best practices and anti-patterns"
  - "Case Studies: Real-world applications"
  - "Future Directions: Emerging trends"
```

## 📈 Performance

**Test Results** (9-hour overnight run):

- **Rounds Completed**: 59
- **Total Output**: ~200,000 words
- **Average Round Duration**: ~9 minutes
- **Self-Trigger Success Rate**: 98% (58/59)
- **Cost**: ~$0.00 (using aicodewith-claude with free tier)

**Theme Distribution**:
- Domain Expertise: 25%
- System Thinking: 20%
- User Understanding: 20%
- Free Exploration: 18%
- Practical Application: 17%

## 🔧 Advanced Configuration

### Custom Exploration Prompts

Create `prompts/exploration-template.md`:

```markdown
You are in exploration round {{round_number}}.

**Theme**: {{theme_name}}
**Previous Round**: {{previous_theme}}

**Objectives**:
1. Deep dive into {{theme_description}}
2. Connect with insights from previous rounds
3. Generate actionable takeaways

**Output Requirements**:
- 2,000-5,000 words
- Structured with clear sections
- Include examples and evidence
- End with "Next Steps" section
```

### Multi-Model Support

Use different models for different themes:

```yaml
themes:
  - name: "Code Architecture"
    model: "aicodewith-claude/claude-opus-4-5"
    reasoning: true
  
  - name: "Creative Exploration"
    model: "google/gemini-3.1-pro"
    reasoning: false
```

## 🐛 Troubleshooting

### Evolution Stops Prematurely

**Check**:
```bash
# View cron job status
openclaw cron list

# Check last run logs
tail -n 100 ~/.openclaw/agents/main/sessions/[session-id].jsonl
```

**Common Causes**:
- API key out of credits → Check provider billing
- Time deadline reached → Expected behavior
- Manual stop → Check cron job `enabled` status

### No Output Files Generated

**Check**:
```bash
# Verify output directory exists
ls -la memory/evolution/

# Check file permissions
ls -l memory/evolution/
```

**Fix**:
```bash
mkdir -p memory/evolution
chmod 755 memory/evolution
```

### Self-Triggering Not Working

**Verify**:
```bash
# Check if exec tool is available
openclaw doctor --tools exec

# Check cron job payload
openclaw cron list --verbose
```

## 🤝 Contributing

We welcome contributions! See `CONTRIBUTING.md` for guidelines.

**Areas We'd Love Help With**:

- Additional safety mechanisms
- Multi-agent collaboration patterns
- Visual dashboard for evolution progress
- Export formats (PDF, notion, etc.)
- Integration with external tools (Obsidian, Roam, etc.)

## 📄 License

MIT License - see `LICENSE` file

## 🙏 Acknowledgments

Built with [OpenClaw](https://github.com/openclaw/openclaw) - The open-source AI agent framework.

Inspired by:
- [AI-Scientist-v2](https://github.com/SakanaAI/AI-Scientist-v2) - Agentic tree search
- [EvoAgentX](https://github.com/example/evoagentx) - HITL checkpoint design
- The OpenClaw community

## 📞 Support

- **Documentation**: https://docs.openclaw.ai
- **Discord**: https://discord.com/invite/clawd
- **Issues**: https://github.com/your-org/openclaw-evolution-framework/issues

---

**Built by AI agents, for AI agents.** 🌳
