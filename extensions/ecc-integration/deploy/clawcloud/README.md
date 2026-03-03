# OpenClaw + ECC Integration

A hybrid AI agent system combining Everything-Claude-Code (ECC) expertise with OpenClaw's operational capabilities.

## Features

- **Three Core Rules**: Strict governance (Rules > Freedom, One Agent/One Task, ECC Integration)
- **Mandatory Skill Security**: 14 security patterns for safe skill imports
- **NVIDIA NIM Integration**: Access to 11 free AI models
- **Intelligent Model Routing**: Automatic model selection based on task
- **Multi-Agent Orchestration**: Self-improving agent system
- **NVIDIA AI Blueprints**: Pre-loaded RAG, Documentation, Safety workflows

## Requirements

Before deploying, prepare:

1. **NVIDIA API Key** (Required)
   - Visit https://build.nvidia.com
   - Create free account
   - Generate API key
   - Copy the key for deployment

2. **PostgreSQL Database** (Optional but recommended)
   - Sign up at https://neon.tech (free tier: 512MB)
   - Create database
   - Copy connection string
   - Format: `postgresql://user:password@host:5432/database`

3. **Redis Cache** (Optional but recommended)
   - Sign up at https://upstash.com (free tier)
   - Create Redis database
   - Copy connection string
   - Format: `redis://default:password@host:port`

## Quick Start

1. Click "Deploy" button
2. Enter your NVIDIA API Key
3. Enter database URL (if available)
4. Enter Redis URL (if available)
5. Wait for deployment (2-3 minutes)
6. Access your OpenClaw instance

## Architecture

The deployment includes:

- **Gateway** (Port 3000): Main entry point, handles routing
- **API** (Port 3001): REST API endpoints
- **Worker** (Background): Task queue processing

## Usage

### API Endpoints

```
GET  /health          - Health check
POST /api/generate    - Generate with intelligent routing
POST /api/blueprints  - List available blueprints
GET  /api/models      - List available models
```

### Example: Generate Text

```bash
curl -X POST https://your-domain.run.claw.cloud/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Hello"}],
    "requireThinking": true
  }'
```

### Example: Execute Blueprint

```bash
curl -X POST https://your-domain.run.claw.cloud/api/blueprints/nvidia-rag-v1 \
  -H "Content-Type: application/json" \
  -d '{
    "documents": ["./docs"],
    "query": "How does it work?"
  }'
```

## Available Models

| Model | Parameters | Best For |
|-------|------------|----------|
| Qwen 3.5 | 397B | Complex reasoning |
| DeepSeek V3.2 | - | Code generation |
| Kimi K2.5 | - | Long context (200K) |
| GLM-5 | - | Documentation |
| Step 3.5 Flash | - | Fast responses |
| Gemma 3N | 2B | Ultra-fast tasks |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| NVIDIA_API_KEY | Yes | API key from build.nvidia.com |
| DATABASE_URL | No | PostgreSQL connection string |
| REDIS_URL | No | Redis connection string |

## Resource Usage

- CPU: 1.25 cores (500m + 500m + 250m)
- Memory: 2.5 GB (1Gi + 1Gi + 512Mi)
- Storage: 5 GB
- Network: Unlimited within plan

## Support

- GitHub: https://github.com/openclaw/openclaw
- Documentation: https://docs.openclaw.ai
- Discord: https://discord.gg/openclaw

## License

MIT License - See LICENSE file for details.

## Version

2026.3.3 - ECC Integration Release
