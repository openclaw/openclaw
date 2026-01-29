# DNA 🧬

**Your AI-Powered Personal Assistant**

DNA is a self-hosted AI assistant that connects to your favorite messaging platforms and helps you get things done. Chat with it on WhatsApp, Telegram, Discord, or Slack — it remembers context, learns your preferences, and has access to powerful tools.

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-18%2B-green)
![Version](https://img.shields.io/badge/version-1.0.0-purple)
![Skills](https://img.shields.io/badge/skills-60%2B-orange)

---

## ✨ Features

### 🗣️ Multi-Platform Messaging
- **WhatsApp** — Chat with your AI via WhatsApp
- **Telegram** — Full bot integration
- **Discord** — Server and DM support
- **Slack** — Workspace integration
- **Signal** — Private messaging

### 🧠 Intelligent Memory
- **Long-term memory** — Remembers important facts about you
- **Session context** — Maintains conversation flow
- **Daily notes** — Automatic journaling of interactions
- **Memory search** — Recall past conversations

### 🛠️ Powerful Tools
- **Web search** — Search the internet
- **File operations** — Read, write, organize files
- **Code execution** — Run scripts and commands
- **Browser control** — Automate web tasks
- **Calendar & Email** — Integrate with your schedule

### 💻 DNA IDE (Included)
A full-featured, AI-native code editor:
- Monaco editor with IntelliSense
- AI chat panel with context awareness
- Inline code editing (Cmd+K)
- Integrated terminal
- Git integration
- Built-in browser preview
- Agent mode for autonomous coding

### 📚 60+ Skills
Pre-built capabilities including:
- GitHub integration
- Google Workspace (Gmail, Calendar)
- Notion, Trello, Slack
- Weather, reminders, notes
- And many more...

---

## 🚀 Quick Start

### Prerequisites
- **Node.js 18+** 
- **macOS, Linux, or Windows (WSL)**
- **API key** from Anthropic, OpenAI, or OpenRouter

### Installation

```bash
# Clone the repository
git clone https://github.com/vanek-nutic/dna.git
cd dna

# Install dependencies
npm install

# Build
npm run build

# Run setup wizard
./dna.mjs wizard
```

### Setup Wizard

The wizard will guide you through:
1. **Choose AI provider** — Anthropic, OpenAI, Google, or OpenRouter
2. **Enter API key** — Securely stored in your system keychain
3. **Connect messaging** — Scan QR code for WhatsApp, get bot token for Telegram
4. **Set workspace** — Where DNA stores your files and memory

### Start DNA

```bash
# Start the gateway
./dna.mjs gateway start

# Or run in foreground
./dna.mjs gateway run
```

---

## 📱 Connect Your Channels

### WhatsApp
```bash
./dna.mjs wizard
# Select "WhatsApp"
# Scan QR code with your phone
```

### Telegram
1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Create a new bot, get token
3. Add to config:
```json
{
  "channels": {
    "telegram": {
      "token": "your-bot-token"
    }
  }
}
```

### Discord
1. Create app at [Discord Developer Portal](https://discord.com/developers)
2. Get bot token
3. Add to config:
```json
{
  "channels": {
    "discord": {
      "token": "your-bot-token"
    }
  }
}
```

---

## ⚙️ Configuration

Config file: `~/.dna/dna.json`

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4"
      },
      "workspace": "/path/to/your/workspace"
    }
  },
  "channels": {
    "whatsapp": {
      "enabled": true
    }
  }
}
```

### Supported Models

| Provider | Models |
|----------|--------|
| Anthropic | claude-opus-4, claude-sonnet-4 |
| OpenAI | gpt-4o, gpt-4-turbo |
| Google | gemini-pro, gemini-ultra |
| OpenRouter | 100+ models |
| Ollama | Local models (free) |

---

## 🏠 Workspace Setup

DNA uses a workspace folder for memory and configuration:

```
~/your-workspace/
├── AGENTS.md      # Agent behavior rules
├── SOUL.md        # Personality & preferences
├── USER.md        # Information about you
├── MEMORY.md      # Long-term memory
├── TOOLS.md       # Tool-specific notes
├── HEARTBEAT.md   # Proactive check rules
├── memory/        # Daily session logs
├── knowledge/     # Bug tracking & learning
└── skills/        # Custom skills
```

Copy the templates to get started:
```bash
cp -R workspace-template/* ~/your-workspace/
```

---

## 💻 DNA IDE

The included IDE is a full-featured development environment:

```bash
cd extensions/ide
npm install
npm start
# Open http://localhost:3333
```

### Features
- **AI Chat** — Discuss code with context awareness
- **Inline Edit** — Select code, press Cmd+K, describe changes
- **Agent Mode** — Let AI make multi-file changes autonomously
- **Memory Integration** — AI knows your project history
- **Git Panel** — Stage, commit, push without leaving IDE
- **Terminal** — Integrated shell access
- **Browser Preview** — Test web apps inline

See [extensions/ide/README.md](extensions/ide/README.md) for full documentation.

---

## 📦 Skills

Skills extend DNA's capabilities. Browse available skills in `skills/`:

```bash
ls skills/
```

### Popular Skills

| Skill | Description |
|-------|-------------|
| `github` | GitHub CLI integration |
| `gog` | Google Workspace (Gmail, Calendar) |
| `notion` | Notion API |
| `weather` | Weather forecasts |
| `coding-agent` | Run coding agents |
| `dna-expert` | Self-help for DNA issues |

### Using Skills

Skills are automatically available. Just ask DNA:
- "Check my GitHub notifications"
- "What's on my calendar today?"
- "What's the weather in New York?"

### Creating Custom Skills

```bash
mkdir skills/my-skill
```

Create `skills/my-skill/SKILL.md`:
```markdown
# My Skill

Description of what this skill does.

## Commands

- `my-command` — Does something useful

## Usage

Explain how to use it.
```

---

## 🧠 Memory System

DNA has a two-layer memory system:

### Daily Notes (`memory/YYYY-MM-DD.md`)
- Automatic logging of sessions
- Raw context and decisions
- Created per day

### Long-term Memory (`MEMORY.md`)
- Curated important facts
- Preferences and patterns
- Manually maintained

### Memory Commands

In chat:
- "Remember that I prefer dark themes"
- "What did we discuss yesterday?"
- "Search memory for project X"

---

## 🔒 Security

- **API keys** stored in system keychain (not config files)
- **Local-first** — Your data stays on your machine
- **Allowlists** — Control who can message your bot
- **No telemetry** — No data sent to third parties

### Privacy Settings

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+1234567890"]
    }
  }
}
```

---

## 🛠️ Development

### Building from Source

```bash
git clone https://github.com/vanek-nutic/dna.git
cd dna
npm install
npm run build
```

### Running Tests

```bash
npm test
```

### Project Structure

```
dna/
├── src/              # TypeScript source
├── dist/             # Compiled output
├── skills/           # Skill definitions
├── extensions/       # Extensions (IDE, etc.)
├── workspace-template/  # Default workspace files
├── knowledge/        # BugDNA system
└── templates/        # Document templates
```

---

## 📖 Documentation

- [Installation Guide](docs/installation.md)
- [Configuration Reference](docs/configuration.md)
- [Skills Development](docs/skills.md)
- [API Reference](docs/api.md)
- [Troubleshooting](docs/troubleshooting.md)

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

DNA is a fork of [Moltbot/Clawdbot](https://github.com/moltbot/moltbot), enhanced with additional features and the DNA IDE.

---

**Built with 🧬 by the DNA team**
