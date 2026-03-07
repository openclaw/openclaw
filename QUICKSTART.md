# 🚀 SotyBot Quick Start

## Installation

```bash
# Clone the repository
git clone https://github.com/sotyhub/sotybot.git
cd sotybot

# Install dependencies
pip install -e .
```

## Quick Test (Without Docker)

```bash
# Start the server
python -m cli.main serve

# In another terminal, test the API
curl http://localhost:8000/health
```

## Using the CLI

```bash
# List available agents
python -m cli.main agent list

# Load an agent
python -m cli.main agent load creative/content_generator

# Execute a task
python -m cli.main exec creative_writer "generate blog ideas about AI"

# Get agent info
python -m cli.main agent info creative_writer

# Unload agent
python -m cli.main agent unload creative_writer
```

## Using Docker

```bash
# Copy environment file
cp .env.example .env

# Start all services
docker-compose up --build

# API available at http://localhost:8000
# Docs at http://localhost:8000/docs
```

## API Examples

```bash
# List all agents
curl http://localhost:8000/agents/

# Load an agent
curl -X POST http://localhost:8000/agents/load \
  -H "Content-Type: application/json" \
  -d '{"agent_path": "creative/content_generator"}'

# Execute a task
curl -X POST http://localhost:8000/agents/execute \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "creative_writer",
    "task": "generate blog ideas about open source AI"
  }'

# Get agent capabilities
curl http://localhost:8000/agents/creative_writer/capabilities
```

## Example Agents Included

### Creative Writer (`creative/content_generator`)
- Generate blog post ideas
- Create social media content
- Brainstorm creative concepts
- Write story prompts

### Security Threat Analyzer (`security/threat_analyzer`)
- Analyze file hashes for malware
- Check URLs for threats
- Get threat intelligence
- Security recommendations

## Next Steps

1. Read the full [README](README_SOTYBOT.md)
2. Check the [Architecture](docs/ARCHITECTURE.md)
3. Build your own agent - see [Agent Development Guide](docs/AGENT_DEV.md)
4. Join the community on [Discord](https://discord.gg/sotyhub)

## Troubleshooting

**Port already in use?**
```bash
python -m cli.main serve --port 8001
```

**Agent not loading?**
- Check that `manifest.json` exists
- Verify `agent.py` has an `agent` instance
- Check logs for errors

**Need help?**
- Open an issue on GitHub
- Join our Discord community
- Check the documentation
