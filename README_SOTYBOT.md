# 🤖 SotyBot - The Open Agent Engine

**An open-source operating system for autonomous AI agents**

Not another chatbot. Not another personal assistant.  
**A domain-agnostic engine where anyone can create agents that think, act, and automate tasks in the real world.**

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Python](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![Docker](https://img.shields.io/badge/docker-ready-brightgreen.svg)](https://www.docker.com/)

---

## 🌟 Vision

SotyBot is the **infrastructure layer for autonomous agents**. It's designed to be:

- **🌍 Universal**: Works across ANY domain (security, crypto, creative, sports, politics, business, etc.)
- **⚡ Actionable**: Agents don't just chat—they execute real actions (APIs, workflows, automation)
- **🔓 Open**: Community-driven agent marketplace, not a closed ecosystem
- **🛡️ Safe**: Robust permission system, sandboxing, and audit trails
- **📈 Extensible**: Plugin architecture that doesn't limit what's possible in 1 year

Think of it as:
- 🧠 **ChatGPT** but hackeable and domain-agnostic
- 🧩 **Zapier** + autonomous decision-making agents
- 🧬 **A nervous system for the internet**

---

## 🚀 Quick Start

### Docker (Recommended)

```bash
# Clone the repository
git clone https://github.com/sotyhub/sotybot.git
cd sotybot

# Copy environment template
cp .env.example .env

# Start the engine
docker-compose up --build

# Engine running at http://localhost:8000
# API docs at http://localhost:8000/docs
```

### Local Development

```bash
# Install dependencies
pip install -e ".[dev]"

# Run the engine
python -m engine.core.app

# Or use uvicorn directly
uvicorn engine.core.app:app --reload
```

---

## 💡 What Makes SotyBot Different?

### Traditional AI Assistants
❌ Limited to predefined domains  
❌ Can't execute real actions  
❌ Closed ecosystems  
❌ One-size-fits-all approach  

### SotyBot
✅ **Domain-agnostic** - supports ANY vertical  
✅ **Action-oriented** - executes APIs, scripts, workflows  
✅ **Open marketplace** - community builds agents  
✅ **Modular** - use only what you need  

---

## 🎯 Example Use Cases

### Security Professional
```bash
# Install malware analysis agent
sotybot agent install malware_analyst

# Analyze suspicious file
sotybot exec malware_analyst "analyze hash abc123def456..."
```

### Crypto Trader
```bash
# Install DeFi research agent
sotybot agent install defi_researcher

# Get market analysis
sotybot exec defi_researcher "analyze Bitcoin market trends"
```

### Content Creator
```bash
# Install creative writing agent
sotybot agent install creative_writer

# Generate blog ideas
sotybot exec creative_writer "generate blog ideas about AI"
```

### Sports Analyst
```bash
# Install betting analysis agent
sotybot agent install betting_analyst

# Get predictions
sotybot exec betting_analyst "analyze upcoming NBA games"
```

**The possibilities are endless** - and the community decides what gets built.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      SotyBot Engine                         │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────────┐  │
│  │   Agent    │  │  Action    │  │   Permission &       │  │
│  │  Registry  │  │  Executor  │  │   Trust System       │  │
│  └────────────┘  └────────────┘  └──────────────────────┘  │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────────┐  │
│  │ Marketplace│  │   Audit    │  │   API & WebSocket    │  │
│  │  Discovery │  │   Logger   │  │      Interface       │  │
│  └────────────┘  └────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
    ┌───▼────┐         ┌────▼────┐        ┌────▼────┐
    │Security│         │ Crypto  │        │Creative │
    │ Agents │         │ Agents  │        │ Agents  │
    └────────┘         └─────────┘        └─────────┘
        │                   │                   │
    ┌───▼────┐         ┌────▼────┐        ┌────▼────┐
    │VirusTotal│       │CoinGecko│        │  LLM    │
    │  API    │        │  API    │        │  Local  │
    └─────────┘        └─────────┘        └─────────┘
```

### Core Components

1. **Agent Runtime**: Domain-agnostic agent loading and execution
2. **Action Executor**: Sandboxed execution of APIs, scripts, workflows
3. **Permission System**: Role-based access control (READ_ONLY, ANALYSIS, AUTOMATION, CRITICAL)
4. **Marketplace**: Agent discovery, ratings, and community feedback
5. **Audit Logger**: Comprehensive logging of all agent and action executions

---

## 🛠️ Building Your First Agent

Create a new agent in under 10 minutes:

```python
# agents/my_domain/my_agent/agent.py
from engine.agents.base import BaseAgent

class MyAgent(BaseAgent):
    async def initialize(self, config):
        # Setup your agent
        self.mark_initialized()
    
    async def execute(self, task, context=None):
        # Execute the task
        result = {"message": f"Processed: {task}"}
        self.record_execution(success=True)
        return result
    
    def get_capabilities(self):
        return ["Describe what your agent can do"]
    
    async def cleanup(self):
        # Cleanup resources
        pass

agent = MyAgent()
```

```json
// agents/my_domain/my_agent/manifest.json
{
  "name": "my_agent",
  "version": "0.1.0",
  "author": "Your Name",
  "description": "What your agent does",
  "domain": "your_domain",
  "capabilities": ["List of capabilities"],
  "required_actions": [],
  "risk_level": "read_only"
}
```

See [Agent Development Guide](docs/AGENT_DEV.md) for full documentation.

---

## 🌐 Connection to SotyHub

SotyBot is built with the same values as [SotyHub.com](https://sotyhub.com):

- **Community-driven**: The community decides what gets built
- **Open and accessible**: No gatekeeping, no barriers
- **Expansive**: Supports all domains and verticals
- **Empowering**: Gives everyone the tools to build

**SotyHub** = The social community  
**SotyBot** = The technical infrastructure

Together, they create an ecosystem where anyone can build, share, and monetize AI agents.

---

## 📚 Documentation

- [Architecture Overview](docs/ARCHITECTURE.md)
- [Agent Development Guide](docs/AGENT_DEV.md)
- [Security Model](docs/SECURITY.md)
- [Manifesto & Philosophy](docs/MANIFESTO.md)
- [Roadmap](docs/ROADMAP.md)

---

## 🤝 Contributing

We welcome contributions from everyone! Here's how to get started:

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-agent`
3. **Make your changes**
4. **Run tests**: `pytest tests/`
5. **Submit a pull request**

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.

### Ways to Contribute

- 🤖 **Build agents** for new domains
- 🔌 **Create action connectors** (APIs, databases, tools)
- 📖 **Improve documentation**
- 🐛 **Report bugs** and suggest features
- ⭐ **Star the repo** and spread the word

---

## 🗺️ Roadmap

### v0.1 (MVP) - Q1 2026 ✅
- ✅ Core engine with domain-agnostic architecture
- ✅ Agent runtime and registry
- ✅ Action execution system
- ✅ Permission and trust system
- ✅ Example agents (creative, security, crypto, sports, politics)
- ✅ Basic marketplace foundation

### v0.5 - Q2 2026
- Enhanced action connectors (more APIs, databases)
- Agent collaboration (agents calling other agents)
- Web dashboard for agent management
- Improved trust scoring and verification

### v1.0 - Q3 2026
- Multi-device support
- Mobile agents (iOS, Android)
- Cloud deployment options
- Advanced workflow orchestration

### v2.0 - Q4 2026
- Agent marketplace with payments
- Verified agent program
- Enterprise features
- Revenue sharing for agent creators

### v3.0 - 2027
- Multi-agent workflows
- Autonomous agent teams
- AI-powered agent creation
- Global agent mesh network

---

## 📜 License

SotyBot is licensed under the **Apache License 2.0**.

This means:
- ✅ Free to use, modify, and distribute
- ✅ Can be used commercially
- ✅ Patent protection
- ✅ Must include license and copyright notice

See [LICENSE](LICENSE) for full details.

---

## 🙏 Acknowledgments

Built with ❤️ by the SotyHub community.

Special thanks to:
- All contributors who build agents
- The open source community
- Everyone who believes in open, accessible AI

---

## 📞 Contact & Community

- **Website**: [sotyhub.com](https://sotyhub.com)
- **GitHub**: [github.com/sotyhub/sotybot](https://github.com/sotyhub/sotybot)
- **Discord**: [Join our community](https://discord.gg/sotyhub)
- **Twitter**: [@SotyHub](https://twitter.com/sotyhub)

---

<div align="center">

**⭐ Star us on GitHub if you believe in open agent infrastructure! ⭐**

Made with 🤖 by the SotyHub community

</div>
