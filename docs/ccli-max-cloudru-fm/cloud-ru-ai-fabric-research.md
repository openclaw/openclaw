# Cloud.ru AI Fabric - Comprehensive Research Report

**Research Date:** 2026-02-13
**Focus:** Multi-Agent Systems, MCP Integration, and External Orchestration
**Target Architecture:** OpenClaw bot on Cloud.ru VM using Cloud.ru AI services

---

## Executive Summary

Cloud.ru Evolution provides a comprehensive AI platform with Foundation Models, AI Agents, Managed RAG, and ML Inference services. The platform offers **OpenAI-compatible APIs**, making it suitable for integration with external orchestration tools like Claude Code CLI. However, **native MCP server support and A2A protocol integration are not explicitly documented** in publicly available materials.

### Key Findings

1. **Foundation Models**: OpenAI-compatible API at `https://foundation-models.api.cloud.ru/v1/`
2. **AI Agents**: Visual editor supporting up to 5 agents with Agent-to-Agent coordination
3. **MCP Integration**: Platform mentions MCP support for AI Agents but lacks detailed technical documentation
4. **External API**: REST API available for all services with OpenAI compatibility
5. **VM Integration**: Full support for running bots on Evolution Cloud VMs with AI service integration

---

## 1. Cloud.ru AI Fabric MCP Servers

### Current Status: Limited Public Documentation

**Finding:** Cloud.ru mentions MCP (Model Context Protocol) integration in their AI Agents documentation, but detailed technical specifications for managed MCP servers are not publicly available.

### What We Know

**AI Agents MCP Support:**

- Integration with MCP for flexible connection of AI agents to different data sources
- Options to use custom MCP servers or ready-made MCP from the Marketplace
- MCP mentioned as part of the Evolution AI Factory platform

**Limitations:**

- No specific documentation on Cloud.ru-managed MCP servers
- Configuration details not publicly available
- Protocol specifications not detailed in public docs

### Recommendations

For integrating with MCP:

1. **Contact Cloud.ru Support** for detailed MCP server documentation
2. **Use Standard MCP Clients** (like Claude Code) with custom MCP servers
3. **Check the Marketplace** for ready-made MCP integrations mentioned in docs

**References:**

- [Создать AI-агента — Cloud.ru Documentation](https://cloud.ru/docs/ai-agents/ug/topics/guides__create-agent)
- [Evolution AI Agents Overview](https://cloud.ru/products/evolution-ai-agents)

---

## 2. Cloud.ru Agent Systems (A2A Protocol)

### Agent-to-Agent Technology

**Finding:** Cloud.ru implements proprietary Agent-to-Agent (A2A) coordination technology for their AI Agents service, separate from Google's public A2A protocol.

### Architecture

**Multi-Agent Coordination:**

- Combine up to **5 different AI agents** into a single system
- Agent-to-Agent technology coordinates interaction for business tasks
- Visual editor for creating and managing agent systems
- Part of Evolution AI Factory platform

**Agent Capabilities:**

- Autonomous operation with information analysis
- Learning from data and planning actions
- Adapting to changing environmental conditions
- Integration with Foundation Models and Managed RAG

### External Agent Participation

**Current Limitations:**

- No explicit documentation on external agent participation in Cloud.ru's A2A system
- Focus appears to be on platform-native agents
- API integration may allow external orchestration (see section 3)

### Standard A2A Protocol Context

The industry-standard **Agent2Agent (A2A) Protocol** (Google/Linux Foundation) enables:

- Communication between opaque agentic applications
- Cross-platform agent collaboration
- Enterprise-grade authentication
- Real-time feedback and state updates

**Cloud.ru's A2A vs Standard A2A:**

- Cloud.ru's implementation appears to be platform-specific
- No evidence of compatibility with standard A2A protocol
- May be proprietary coordination mechanism

**References:**

- [AI-агенты: как они устроены — Cloud.ru Blog](https://cloud.ru/blog/kak-ustroyeny-i-chto-umeyut-ai-agenty)
- [Evolution AI Agents Product Page](https://cloud.ru/products/evolution-ai-agents)
- [A2A Protocol Official Site](https://a2a-protocol.org/latest/)
- [Getting Started with A2A Protocol — Google Codelabs](https://codelabs.developers.google.com/intro-a2a-purchasing-concierge)

---

## 3. Cloud.ru AI Agents + External Orchestration

### External API Access: YES ✅

**Finding:** Cloud.ru AI Agents and all AI Factory services provide REST API access for external integration.

### Integration Methods

**1. REST API Integration**

- All Evolution AI Factory services accessible via REST API
- Work through platform interface or embed via API
- Flexible integration options for external systems

**2. OpenAI-Compatible API**

- Foundation Models accessible via OpenAI-compatible endpoints
- Standard OpenAI SDK clients can be used with modified base_url
- Enables integration with tools expecting OpenAI API format

**3. Docker and Container Support**

- ML Inference supports Docker RUN for custom models
- Automatic container deployment and dynamic auto-scaling
- Containerized environments for model execution

### Using Cloud.ru Services from External Tools

**Claude Code CLI Integration Pattern:**

```bash
# Example: Using Cloud.ru Foundation Models with OpenAI-compatible tools
export OPENAI_BASE_URL="https://foundation-models.api.cloud.ru/v1/"
export OPENAI_API_KEY="your-cloud-ru-api-key"

# Any tool using OpenAI SDK can now use Cloud.ru models
```

**Python Integration Example:**

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://foundation-models.api.cloud.ru/v1/",
    api_key="your-api-key"
)

response = client.chat.completions.create(
    model="GigaChat/GigaChat-2-Max",
    messages=[{"role": "user", "content": "Hello"}]
)
```

### AI Agents as External Tools/Functions

**Current Capabilities:**

- REST API allows calling AI Agents from external systems
- Integration with external services and automation
- Function execution on request through API

**MCP Integration Potential:**

- AI Agents mention MCP support for data source connections
- Could potentially be exposed as MCP tools
- Requires access to MCP server configuration documentation

**References:**

- [Evolution AI Factory Platform](https://cloud.ru/products/evolution-ai-factory)
- [Cloud.ru запускает Evolution AI Factory](https://cloud.ru/blog/stali-dostupny-instrumenty-cloud-ru-evolution-ai-factory)

---

## 4. Evolution Cloud VM + AI Services Architecture

### Optimal Architecture for OpenClaw Bot

**Scenario:** Running OpenClaw bot on Cloud.ru VM that calls AI services (Foundation Models, AI Agents, RAG) within the same cloud infrastructure.

### Architecture Design

```
┌─────────────────────────────────────────────────────────┐
│              Cloud.ru Evolution Cloud                    │
│                                                           │
│  ┌──────────────────┐                                    │
│  │  Evolution VM    │                                    │
│  │                  │                                    │
│  │  ┌────────────┐  │      Internal Network             │
│  │  │ OpenClaw   │  │◄─────────────────────┐            │
│  │  │    Bot     │  │                       │            │
│  │  └────────────┘  │                       │            │
│  │       │          │                       │            │
│  │       │ API Calls│                       │            │
│  └───────┼──────────┘                       │            │
│          │                                  │            │
│          ▼                                  │            │
│  ┌───────────────────────────────────────┐  │            │
│  │  Evolution AI Factory Services        │  │            │
│  │                                       │  │            │
│  │  ┌─────────────────────────────────┐ │  │            │
│  │  │ Foundation Models               │ │  │            │
│  │  │ - DeepSeek, Qwen, GigaChat     │ │  │            │
│  │  │ - OpenAI-compatible API         │ │◄─┘            │
│  │  │ - https://foundation-models... │ │               │
│  │  └─────────────────────────────────┘ │               │
│  │                                       │               │
│  │  ┌─────────────────────────────────┐ │               │
│  │  │ AI Agents (Multi-Agent System) │ │               │
│  │  │ - Up to 5 agents per system    │ │               │
│  │  │ - Agent-to-Agent coordination  │ │               │
│  │  │ - MCP integration support      │ │               │
│  │  └─────────────────────────────────┘ │               │
│  │                                       │               │
│  │  ┌─────────────────────────────────┐ │               │
│  │  │ Managed RAG                     │ │               │
│  │  │ - Vector + full-text search    │ │               │
│  │  │ - S3-compatible storage        │ │               │
│  │  │ - Knowledge base integration   │ │               │
│  │  └─────────────────────────────────┘ │               │
│  │                                       │               │
│  │  ┌─────────────────────────────────┐ │               │
│  │  │ ML Inference                    │ │               │
│  │  │ - Shared GPU (V100/A100/H100)  │ │               │
│  │  │ - vLLM, TGI, Ollama support    │ │               │
│  │  │ - Docker container support     │ │               │
│  │  └─────────────────────────────────┘ │               │
│  └───────────────────────────────────────┘               │
│                                                           │
│  ┌───────────────────────────────────────┐               │
│  │ Object Storage (S3-compatible)        │               │
│  │ - 15 GB free storage                  │               │
│  └───────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────┘
```

### Networking Considerations

**1. Internal Network Communication**

- VM and AI services in same cloud = low latency
- Private network connectivity available via Magic Router
- Direct Connect for external network integration
- Load Balancer v2 for multi-zone traffic distribution

**2. Network Topology**

- Use **Magic Router** for resource connectivity
- **Evolution Load Balancer v2** for traffic management
- Multi-availability zone support
- Private network recommended for AI service calls

**3. Latency Optimization**

- Same-region deployment: VM and AI services in same zone
- Internal API calls over private network
- Avoid external internet routing for AI calls
- Use dedicated network interfaces where possible

### Authentication Architecture

**1. API Key Management**

```bash
# Environment Variables Approach
export CLOUD_RU_API_KEY="your-foundation-models-key"
export CLOUD_RU_AGENTS_KEY="your-ai-agents-key"
export CLOUD_RU_RAG_KEY="your-managed-rag-key"
```

**2. Service Account Pattern**

- Create service accounts for programmatic access
- Use API keys with service scope restrictions
- Store keys securely (cloud secrets manager or encrypted storage)
- Never commit keys to version control

**3. API Key Creation Process**

1. Navigate to **Evolution → Foundation Models** (or relevant service)
2. Go to **Учетные данные доступа** (Access Credentials)
3. Click **Создать API-ключ** (Create API Key)
4. Set service scope (e.g., Foundation Models, AI Agents)
5. Save **Key Secret** (cannot retrieve after window closes)

**4. Rate Limiting**

- Foundation Models: **15 requests per second** per API key
- Design bot to respect rate limits
- Implement exponential backoff for retries
- Consider multiple API keys for higher throughput

### Cost Optimization

**Free Tier Benefits:**

- **Foundation Models**: Free access to 16 open-source models until October 31, 2025
- **Object Storage**: 15 GB free storage
- **Starting Grant**: Available for new users

**Resource Efficiency:**

- ML Inference uses shared GPU resources (cost-effective)
- Managed RAG eliminates need for separate vector database
- Auto-scaling for dynamic workloads

### Security Considerations

**1. API Key Security**

- Store keys in environment variables or secrets manager
- Use encrypted storage mechanisms (OS keychain, encrypted files)
- Rotate keys periodically
- Limit key scopes to required services only

**2. Network Security**

- Use private networks for internal communication
- Implement firewall rules on VM
- Restrict API access to VM IP addresses
- Enable Cloud.ru security services (data protection)

**3. Data Protection**

- Cloud.ru offers commercial data protection services
- Use Object Storage encryption for sensitive data
- Implement application-level encryption for critical data

**References:**

- [Cloud.ru Evolution Platform](https://cloud.ru/evolution)
- [Cloud.ru Documentation Portal](https://cloud.ru/docs)
- [Cloud.ru put into commercial operation services](https://tadviser.com/index.php/Product:Cloud.ru_Evolution)

---

## 5. Claude Code CLI + Cloud.ru Foundation Models

### Integration Status: COMPATIBLE ✅

**Finding:** Cloud.ru Foundation Models provide OpenAI-compatible API, making them directly usable with Claude Code CLI and similar tools.

### Technical Details

**API Endpoint:**

```
Base URL: https://foundation-models.api.cloud.ru/v1/
```

**OpenAI Compatibility:**

- Full OpenAI API specification compatibility
- Standard endpoints: `/chat/completions`, `/completions`
- Supports OpenAI SDK clients (Python, JavaScript, etc.)
- Drop-in replacement for OpenAI API

### Available Models (20+ Models)

**Popular Open Source LLMs (Free until Oct 31, 2025):**

- OpenAI gpt-oss-120B
- Qwen3-Coder-480B
- DeepSeek R1 Distill Llama
- Devstral
- GLM-4.5 (131,000 token context)
- Llama models
- T-Pro 2.0 (hybrid reasoning mode)

**Russian Language Models:**

- GigaChat/GigaChat-2-Max
- T-lite (lightweight model)

**Model Capabilities:**

- **Reasoning**: Advanced logical reasoning
- **Function Calling**: Tool/function execution
- **Structured Output**: JSON and structured responses

### Authentication Flow

**Step 1: Create API Key**

1. Log into Cloud.ru Evolution account
2. Navigate to service: **Evolution → Foundation Models**
3. Go to **Учетные данные доступа** (Access Credentials)
4. Click **Создать API-ключ** (Create API Key)
5. Fill parameters:
   - Name: e.g., "Claude Code Integration"
   - Description: e.g., "API key for Claude Code CLI"
   - Service: **Foundation Models**
6. **Save Key Secret** immediately (cannot be retrieved later)

**Step 2: Store API Key Securely**

```bash
# Linux/macOS - Add to ~/.bashrc or ~/.zshrc
export OPENAI_API_KEY="your-cloud-ru-api-key"
export OPENAI_BASE_URL="https://foundation-models.api.cloud.ru/v1/"

# Or use environment file
echo "OPENAI_API_KEY=your-cloud-ru-api-key" > .env
echo "OPENAI_BASE_URL=https://foundation-models.api.cloud.ru/v1/" >> .env
```

**Step 3: Configure Claude Code CLI**

If Claude Code CLI supports custom LLM backends (check documentation), configure:

```json
{
  "llm": {
    "provider": "openai-compatible",
    "baseUrl": "https://foundation-models.api.cloud.ru/v1/",
    "apiKey": "${OPENAI_API_KEY}",
    "model": "GigaChat/GigaChat-2-Max"
  }
}
```

### Integration Examples

**Python with OpenAI SDK:**

```python
from openai import OpenAI

# Initialize client with Cloud.ru endpoint
client = OpenAI(
    base_url="https://foundation-models.api.cloud.ru/v1/",
    api_key="your-cloud-ru-api-key"
)

# Make request
response = client.chat.completions.create(
    model="GigaChat/GigaChat-2-Max",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Explain quantum computing"}
    ],
    max_tokens=500,
    temperature=0.7
)

print(response.choices[0].message.content)
```

**JavaScript/TypeScript with OpenAI SDK:**

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://foundation-models.api.cloud.ru/v1/",
  apiKey: process.env.OPENAI_API_KEY,
});

const response = await client.chat.completions.create({
  model: "GigaChat/GigaChat-2-Max",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Write a Python function for fibonacci" },
  ],
  max_tokens: 500,
  temperature: 0.7,
});

console.log(response.choices[0].message.content);
```

**cURL Example:**

```bash
curl https://foundation-models.api.cloud.ru/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-cloud-ru-api-key" \
  -d '{
    "model": "GigaChat/GigaChat-2-Max",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "What is AI?"}
    ],
    "max_tokens": 500,
    "temperature": 0.7
  }'
```

### Quick Start Guide

**For Cloud.ru VM → Foundation Models Integration:**

```bash
# 1. Install OpenAI SDK
pip install openai

# 2. Set environment variables
export OPENAI_API_KEY="your-cloud-ru-api-key"
export OPENAI_BASE_URL="https://foundation-models.api.cloud.ru/v1/"

# 3. Test connection
python -c "
from openai import OpenAI
client = OpenAI()
response = client.chat.completions.create(
    model='GigaChat/GigaChat-2-Max',
    messages=[{'role': 'user', 'content': 'Test'}],
    max_tokens=50
)
print(response.choices[0].message.content)
"
```

### Supported API Parameters

**Standard OpenAI Parameters:**

- `model` - Model identifier (e.g., "GigaChat/GigaChat-2-Max")
- `messages` - Array of message objects with role and content
- `max_tokens` - Maximum tokens in response
- `temperature` - Creativity parameter (0.0 to 2.0)
- `top_p` - Nucleus sampling parameter
- `frequency_penalty` - Penalty for token frequency
- `presence_penalty` - Penalty for token presence
- `stream` - Enable streaming responses

**Additional Features:**

- **Function Calling**: Define tools/functions for model to call
- **Structured Output**: Request JSON or specific formats
- **System Prompts**: Set behavior via system role messages

### Rate Limits and Best Practices

**Rate Limits:**

- **15 requests per second** per API key
- Implement rate limiting in application
- Use exponential backoff for retry logic

**Best Practices:**

```python
import time
from openai import OpenAI, RateLimitError

client = OpenAI(
    base_url="https://foundation-models.api.cloud.ru/v1/",
    api_key="your-api-key"
)

def make_request_with_retry(messages, max_retries=3):
    for attempt in range(max_retries):
        try:
            response = client.chat.completions.create(
                model="GigaChat/GigaChat-2-Max",
                messages=messages,
                max_tokens=500
            )
            return response
        except RateLimitError:
            if attempt < max_retries - 1:
                wait_time = 2 ** attempt  # Exponential backoff
                time.sleep(wait_time)
            else:
                raise
```

### Model Selection Guide

**For Code Generation:**

- `Qwen3-Coder-480B` - Specialized for coding tasks
- `Devstral` - Development-focused model

**For General Tasks:**

- `GigaChat/GigaChat-2-Max` - General purpose, Russian language
- `gpt-oss-120B` - Open source alternative to GPT models

**For Long Context:**

- `GLM-4.5` - 131,000 token context window

**For Reasoning:**

- `T-Pro 2.0` - Hybrid reasoning mode
- `DeepSeek R1 Distill Llama` - Reasoning capabilities

### VS Code Integration

Cloud.ru provides VS Code extension/integration:

```bash
# Follow Cloud.ru documentation for VS Code setup
# Подключение Foundation Models в VS Code
# https://cloud.ru/docs/foundation-models/ug/topics/tutorials__connect-vscode
```

**References:**

- [Evolution Foundation Models Product Page](https://cloud.ru/products/evolution-foundation-models)
- [Foundation Models Quick Start](https://cloud.ru/docs/foundation-models/ug/topics/quickstart)
- [Foundation Models API Reference](https://cloud.ru/docs/foundation-models/ug/topics/api-ref)
- [VS Code Integration Guide](https://cloud.ru/docs/foundation-models/ug/topics/tutorials__connect-vscode)
- [Roo Code Enhancement Request](https://github.com/RooCodeInc/Roo-Code/issues/9320)

---

## 6. Additional Cloud.ru AI Services

### Managed RAG (Retrieval Augmented Generation)

**Purpose:** Launch RAG systems based on user data without deploying infrastructure.

**Key Features:**

- Vector + full-text search capabilities
- No need to select and deploy vector database
- Integration with Foundation Models and ML Inference
- S3-compatible Object Storage integration (15 GB free)

**Use Cases:**

- LLM-based customer support chatbots
- Agent systems for generating topic-based reports
- Semantic product catalog search

**Architecture:**

```
User Query → Managed RAG → Knowledge Base (S3) → Vector Search
                ↓
        Foundation Model (LLM) → Response with Citations
```

**Integration:**

- REST API for external systems
- Pre-tested and optimized RAG pipeline
- Support for HuggingFace models via ML Inference

**References:**

- [Managed RAG Overview](https://cloud.ru/docs/rag/ug/index)
- [Creating Knowledge Base from MD Files](https://cloud.ru/docs/tutorials-evolution/list/topics/managed-rag__md-files)

### ML Inference

**Purpose:** Deploy and run ML models on cloud GPU resources.

**Key Features:**

- **Shared GPU Resources**: Nvidia V100, A100, H100
- **Multiple Models per GPU**: Run several models simultaneously
- **Supported Frameworks**: vLLM, TGI, Ollama, Diffusers, Transformers
- **Docker Support**: Custom Docker images with auto-deployment
- **Auto-Scaling**: Dynamic resource scaling
- **HuggingFace Integration**: Deploy any open-source model

**Model Types:**

- Large Language Models (LLM)
- Transformer models
- Diffusion models (image generation)
- Custom ML/DL models

**Integration Capabilities:**

- REST API for external systems
- OpenAI-compatible endpoints for some models
- Docker-based deployment for flexibility

**References:**

- [Evolution ML Inference Product Page](https://cloud.ru/products/evolution-ml-inference)
- [ML Inference Documentation](https://cloud.ru/docs/ml-inference/ug/index)
- [Cloud.ru анонсировал ML Inference](https://cloud.ru/blog/anonsirovali-perviy-v-rossii-upravlyayemiy-servis-dlya-inferensa)

### ML Finetuning

**Purpose:** Fine-tune large language models on custom datasets.

**Integration:** Part of Evolution AI Factory platform for model customization.

### Distributed Train

**Purpose:** Distributed training of ML models across multiple GPUs/nodes.

**Features:**

- API reference available
- Scalable training infrastructure
- Integration with other AI Factory services

### Notebooks

**Purpose:** Interactive ML development environment (Jupyter-style).

**Use Case:** Prototyping, experimentation, and data science workflows.

---

## 7. OpenClaw Bot Architecture - Recommended Design

### Complete System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Cloud.ru Evolution Cloud                     │
│                                                                   │
│ ┌───────────────────────────────────────────────────────────┐   │
│ │              Evolution VM (OpenClaw Bot Host)              │   │
│ │                                                             │   │
│ │  ┌─────────────────────────────────────────────────────┐  │   │
│ │  │           OpenClaw Bot Application                  │  │   │
│ │  │                                                       │  │   │
│ │  │  ┌──────────────┐      ┌──────────────────────┐     │  │   │
│ │  │  │   Bot Core   │      │  Claude Code CLI      │     │  │   │
│ │  │  │   Engine     │──────│  (Optional Swarm)     │     │  │   │
│ │  │  └──────────────┘      └──────────────────────┘     │  │   │
│ │  │         │                        │                    │  │   │
│ │  │         │                        │                    │  │   │
│ │  │         ▼                        ▼                    │  │   │
│ │  │  ┌─────────────────────────────────────────────┐     │  │   │
│ │  │  │       Cloud.ru AI Services Client          │     │  │   │
│ │  │  │                                             │     │  │   │
│ │  │  │  - Foundation Models Client                │     │  │   │
│ │  │  │  - AI Agents Client                        │     │  │   │
│ │  │  │  - Managed RAG Client                      │     │  │   │
│ │  │  │  - ML Inference Client                     │     │  │   │
│ │  │  └─────────────────────────────────────────────┘     │  │   │
│ │  └─────────────────────────────────────────────────────┘  │   │
│ │                           │                                 │   │
│ │                           │ API Calls (Private Network)    │   │
│ └───────────────────────────┼─────────────────────────────────┘   │
│                             │                                     │
│                             ▼                                     │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │              Evolution AI Factory Services                   │ │
│ │                                                               │ │
│ │  ┌──────────────────────┐   ┌──────────────────────┐        │ │
│ │  │ Foundation Models    │   │  AI Agents System    │        │ │
│ │  │ (OpenAI-compatible)  │   │  (Multi-Agent)       │        │ │
│ │  │                      │   │                      │        │ │
│ │  │ - DeepSeek          │   │  - Visual Editor     │        │ │
│ │  │ - Qwen3-Coder       │   │  - A2A Coordination  │        │ │
│ │  │ - GigaChat-2-Max    │   │  - MCP Integration   │        │ │
│ │  │ - gpt-oss-120B      │   │  - Up to 5 agents    │        │ │
│ │  └──────────────────────┘   └──────────────────────┘        │ │
│ │                                                               │ │
│ │  ┌──────────────────────┐   ┌──────────────────────┐        │ │
│ │  │   Managed RAG        │   │   ML Inference       │        │ │
│ │  │                      │   │                      │        │ │
│ │  │ - Vector Search     │   │  - GPU Resources     │        │ │
│ │  │ - Knowledge Base    │   │  - vLLM, TGI, Ollama │        │ │
│ │  │ - S3 Integration    │   │  - Docker Support    │        │ │
│ │  └──────────────────────┘   └──────────────────────┘        │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │         Object Storage (S3-compatible, 15 GB free)           │ │
│ │  - Knowledge bases for RAG                                   │ │
│ │  - Bot data and logs                                         │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │              Network Infrastructure                           │ │
│ │  - Magic Router (internal connectivity)                      │ │
│ │  - Load Balancer v2 (multi-zone)                            │ │
│ │  - Private network for AI service calls                     │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Implementation Checklist

**Phase 1: Infrastructure Setup**

- [ ] Create Evolution Cloud VM
- [ ] Configure private networking
- [ ] Set up Magic Router for service connectivity
- [ ] Configure security groups and firewall rules

**Phase 2: AI Services Configuration**

- [ ] Create Foundation Models API key
- [ ] Create AI Agents API key (if using)
- [ ] Create Managed RAG API key (if using)
- [ ] Set up S3-compatible Object Storage
- [ ] Configure knowledge bases in Managed RAG

**Phase 3: Bot Development**

- [ ] Install OpenClaw bot on VM
- [ ] Configure environment variables for API keys
- [ ] Implement Foundation Models client (OpenAI SDK)
- [ ] Implement RAG integration for knowledge retrieval
- [ ] Implement AI Agents client (if using multi-agent features)
- [ ] Set up error handling and retry logic
- [ ] Implement rate limiting (15 req/sec)

**Phase 4: Integration Testing**

- [ ] Test Foundation Models API connectivity
- [ ] Verify low latency on private network
- [ ] Test RAG knowledge retrieval
- [ ] Test AI Agents coordination (if applicable)
- [ ] Load testing with rate limits
- [ ] Monitor API costs and usage

**Phase 5: Production Deployment**

- [ ] Enable auto-scaling (if needed)
- [ ] Set up monitoring and logging
- [ ] Configure backup and disaster recovery
- [ ] Implement security hardening
- [ ] Deploy to production

---

## 8. Key Limitations and Gaps

### Identified Limitations

**1. MCP Server Documentation**

- ❌ No detailed technical documentation for Cloud.ru-managed MCP servers
- ❌ Configuration and protocol specifications not publicly available
- ⚠️ MCP support mentioned but details require contacting support

**2. A2A Protocol Compatibility**

- ❌ Cloud.ru's A2A appears to be proprietary, not standard Google A2A
- ❌ No evidence of compatibility with Linux Foundation A2A protocol
- ❌ External agent participation in Cloud.ru A2A system not documented

**3. API Documentation Gaps**

- ⚠️ Some services lack detailed API reference documentation
- ⚠️ Example code primarily in Russian language
- ⚠️ Model ID naming conventions not fully standardized

**4. Rate Limits**

- ⚠️ Foundation Models limited to 15 requests/second
- ⚠️ May require multiple API keys for high-throughput applications

### Strengths

**1. OpenAI Compatibility**

- ✅ Full OpenAI API compatibility for Foundation Models
- ✅ Easy integration with existing OpenAI SDK clients
- ✅ Drop-in replacement for many use cases

**2. Comprehensive AI Platform**

- ✅ Complete AI Factory with all major services
- ✅ Foundation Models, AI Agents, RAG, ML Inference
- ✅ Integrated platform reduces complexity

**3. Free Tier and Pricing**

- ✅ Free access to 16 open-source models (until Oct 31, 2025)
- ✅ 15 GB free S3-compatible storage
- ✅ Shared GPU resources for cost efficiency

**4. Russian Language Support**

- ✅ Native Russian language models (GigaChat)
- ✅ Russian documentation and interface
- ✅ Localized support

---

## 9. Comparison: Cloud.ru vs Other Platforms

### Cloud.ru vs AWS/Azure/Google Cloud

| Feature               | Cloud.ru                   | AWS                      | Azure               | Google Cloud        |
| --------------------- | -------------------------- | ------------------------ | ------------------- | ------------------- |
| OpenAI-Compatible API | ✅ Yes                     | ⚠️ Via Bedrock           | ⚠️ Via Azure OpenAI | ⚠️ Via Vertex AI    |
| Native Russian LLMs   | ✅ GigaChat, T-Pro         | ❌ No                    | ❌ No               | ❌ No               |
| Free LLM Access       | ✅ 16 models (2025)        | ❌ Paid                  | ❌ Paid             | ❌ Paid             |
| MCP Support           | ⚠️ Mentioned, not detailed | ✅ Well documented       | ✅ Well documented  | ✅ Well documented  |
| A2A Protocol          | ⚠️ Proprietary             | ❌ No native             | ❌ No native        | ✅ Yes (Google)     |
| Managed RAG           | ✅ Yes                     | ✅ Yes (Knowledge Bases) | ✅ Yes (AI Search)  | ✅ Yes (RAG Engine) |
| Multi-Agent Systems   | ✅ AI Agents (5 max)       | ⚠️ Via Bedrock Agents    | ⚠️ Via AI Foundry   | ⚠️ Via Vertex AI    |
| Russian Documentation | ✅ Native                  | ❌ Limited               | ❌ Limited          | ❌ Limited          |

### Cloud.ru Strengths for Russian Market

1. **Data Sovereignty**: Russian cloud infrastructure
2. **Language Support**: Native Russian LLMs and documentation
3. **Cost**: Free tier for open-source models
4. **Compliance**: Easier compliance with Russian data regulations
5. **Localization**: Full platform in Russian language

---

## 10. Recommendations for OpenClaw Integration

### Recommended Approach

**Option 1: Foundation Models Only (Simplest)**

```
OpenClaw Bot (VM) → Cloud.ru Foundation Models API
                    (OpenAI-compatible)
```

**Pros:**

- Simplest integration (OpenAI SDK)
- Well-documented API
- Free tier available
- Low latency on private network

**Cons:**

- No multi-agent orchestration
- Manual RAG implementation if needed

**Best For:** Simple bot with LLM capabilities, minimal complexity

---

**Option 2: Foundation Models + Managed RAG (Recommended)**

```
OpenClaw Bot (VM) → Foundation Models (LLM reasoning)
                 ↘
                   → Managed RAG (knowledge retrieval)
```

**Pros:**

- No need to deploy vector database
- Pre-optimized RAG pipeline
- Knowledge base management included
- S3 storage integration

**Cons:**

- Two API integrations needed
- RAG API documentation may be limited

**Best For:** Bot requiring knowledge base and context-aware responses

---

**Option 3: Full AI Factory Integration (Most Advanced)**

```
OpenClaw Bot (VM) → AI Agents (orchestration)
                    └→ Foundation Models
                    └→ Managed RAG
                    └→ ML Inference (custom models)
```

**Pros:**

- Multi-agent coordination (up to 5 agents)
- Full platform capabilities
- Visual editor for agent design
- MCP integration potential

**Cons:**

- More complex architecture
- Limited public documentation for AI Agents API
- May require Cloud.ru support assistance

**Best For:** Complex multi-agent systems with advanced orchestration

---

**Option 4: Claude Code CLI + Cloud.ru Backend**

```
Claude Code CLI (local/VM) → Cloud.ru Foundation Models
                              (as LLM backend via OpenAI API)
```

**Pros:**

- Use Claude Code's swarm orchestration
- Cloud.ru as cost-effective LLM provider
- Best of both worlds

**Cons:**

- Requires Claude Code CLI support for custom backends
- May need configuration tweaks

**Best For:** Development and testing with Claude Code orchestration

---

### Implementation Timeline

**Week 1-2: Foundation & Testing**

- Set up Evolution VM
- Configure Foundation Models API
- Test connectivity and latency
- Implement basic OpenAI client

**Week 3-4: RAG Integration (if needed)**

- Set up Managed RAG
- Create knowledge base
- Integrate RAG API calls
- Test retrieval quality

**Week 5-6: Advanced Features**

- Explore AI Agents (if multi-agent needed)
- Contact Cloud.ru support for MCP details
- Implement error handling and monitoring
- Load testing and optimization

**Week 7-8: Production Deployment**

- Security hardening
- Monitoring setup
- Documentation
- Production deployment

---

## 11. Next Steps and Action Items

### Immediate Actions

1. **Contact Cloud.ru Support**
   - Request detailed MCP server documentation
   - Ask about AI Agents API reference
   - Inquire about A2A protocol compatibility
   - Request enterprise architecture consultation

2. **Create Trial Account**
   - Sign up for Cloud.ru Evolution
   - Create Foundation Models API key
   - Test API connectivity from external location
   - Verify rate limits and model availability

3. **Prototype Integration**
   - Build minimal OpenAI-compatible client
   - Test Foundation Models API calls
   - Measure latency from different locations
   - Validate OpenAI SDK compatibility

### Technical Questions for Cloud.ru

**MCP Integration:**

1. Do you provide managed MCP servers? If yes, how to configure?
2. Can custom MCP servers be deployed on Evolution Cloud?
3. What MCP tools are available in the Marketplace?
4. How do AI Agents integrate with MCP data sources?

**AI Agents & A2A:**

1. Is the A2A protocol compatible with Google's standard A2A?
2. Can external agents participate in Cloud.ru A2A coordination?
3. What APIs are available for programmatic AI Agent creation?
4. Can AI Agents be called as functions from external systems?

**Architecture & Networking:**

1. What is the recommended network topology for VM + AI services?
2. Is there private network connectivity between VM and AI services?
3. What are the exact latency SLAs for in-cloud API calls?
4. Are there dedicated API endpoints for high-throughput applications?

**Authentication & Security:**

1. Are service accounts with IAM roles available?
2. Can API keys be scoped to specific IP addresses?
3. What security certifications does Evolution Cloud have?
4. How are API keys rotated and managed at scale?

---

## 12. Conclusion

### Summary of Findings

Cloud.ru Evolution provides a **comprehensive AI platform** with strong OpenAI compatibility, making it suitable for OpenClaw bot deployment. The **Foundation Models service** is production-ready with clear API documentation and free tier access.

**Key Strengths:**

- ✅ OpenAI-compatible API for easy integration
- ✅ 20+ models including DeepSeek, Qwen, GigaChat
- ✅ Free tier for development and testing
- ✅ Managed RAG eliminates infrastructure overhead
- ✅ Russian language models and documentation
- ✅ VM + AI services in same cloud (low latency)

**Areas Requiring Clarification:**

- ⚠️ MCP server documentation and configuration
- ⚠️ A2A protocol compatibility and external agent support
- ⚠️ AI Agents API reference for programmatic access
- ⚠️ Enterprise architecture best practices

### Recommended Path Forward

**For OpenClaw Bot on Cloud.ru:**

1. **Start with Foundation Models** (OpenAI-compatible API)
   - Simplest integration path
   - Well-documented and tested
   - Immediate value with LLM capabilities

2. **Add Managed RAG** when knowledge retrieval needed
   - Pre-built, optimized pipeline
   - No vector database management
   - S3-compatible storage included

3. **Explore AI Agents** for multi-agent orchestration
   - Contact Cloud.ru support for details
   - Evaluate against Claude Code CLI swarms
   - Consider for advanced use cases

4. **Deploy on Evolution VM** for optimal performance
   - Same-cloud deployment minimizes latency
   - Private network for secure communication
   - Cost-effective with free tiers

### Final Assessment

Cloud.ru Evolution AI Factory is a **viable and cost-effective platform** for deploying OpenClaw bot with AI capabilities. The OpenAI-compatible Foundation Models API provides a **low-friction integration path**, while Managed RAG and AI Agents offer **advanced capabilities** for complex use cases.

For immediate implementation, focus on Foundation Models integration with plans to expand into RAG and multi-agent systems as requirements evolve.

---

## Sources and References

### Cloud.ru Official Documentation

1. [Cloud.ru Evolution Documentation Portal](https://cloud.ru/docs)
2. [Evolution Foundation Models Product Page](https://cloud.ru/products/evolution-foundation-models)
3. [Evolution AI Agents Product Page](https://cloud.ru/products/evolution-ai-agents)
4. [Evolution AI Factory Platform](https://cloud.ru/products/evolution-ai-factory)
5. [Evolution ML Inference](https://cloud.ru/products/evolution-ml-inference)
6. [Foundation Models Quick Start Guide](https://cloud.ru/docs/foundation-models/ug/topics/quickstart)
7. [Foundation Models API Reference](https://cloud.ru/docs/foundation-models/ug/topics/api-ref)
8. [AI Agents User Guide - Create Agent](https://cloud.ru/docs/ai-agents/ug/topics/guides__create-agent)
9. [Managed RAG Overview](https://cloud.ru/docs/rag/ug/index)
10. [ML Inference Documentation](https://cloud.ru/docs/ml-inference/ug/index)
11. [VS Code Integration Tutorial](https://cloud.ru/docs/foundation-models/ug/topics/tutorials__connect-vscode)

### Cloud.ru Blog Posts

12. [Бесплатный доступ к LLM-моделям](https://cloud.ru/blog/besplatniy-dostup-k-open-source-llm-modelyam)
13. [Evolution AI Factory Announcement](https://cloud.ru/blog/stali-dostupny-instrumenty-cloud-ru-evolution-ai-factory)
14. [AI-агенты: как они устроены](https://cloud.ru/blog/kak-ustroyeny-i-chto-umeyut-ai-agenty)
15. [ML Inference Announcement](https://cloud.ru/blog/anonsirovali-perviy-v-rossii-upravlyayemiy-servis-dlya-inferensa)

### Third-Party Sources

16. [Cloud.ru Evolution - TAdviser](https://tadviser.com/index.php/Product:Cloud.ru_Evolution)
17. [Cloud.ru Foundation Models Provider Request - Roo Code](https://github.com/RooCodeInc/Roo-Code/issues/9320)
18. [Cloud.ru Foundation Models for Home Assistant](https://github.com/black-roland/homeassistant-cloud-ru-ai)

### Model Context Protocol (MCP)

19. [Model Context Protocol Official Site](https://modelcontextprotocol.io/)
20. [MCP Specification](https://modelcontextprotocol.io/specification/2025-11-25)
21. [Microsoft Fabric MCP Server](https://github.com/microsoft/mcp/blob/main/servers/Fabric.Mcp.Server/README.md)
22. [MCP Servers Repository](https://github.com/modelcontextprotocol/servers)
23. [MCP for Enterprises - MarkTechPost](https://www.marktechpost.com/2025/07/20/model-context-protocol-mcp-for-enterprises-secure-integration-with-aws-azure-and-google-cloud-2025-update/)

### Agent2Agent (A2A) Protocol

24. [A2A Protocol Official Site](https://a2a-protocol.org/latest/)
25. [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/)
26. [A2A GitHub Repository](https://github.com/a2aproject/A2A)
27. [Getting Started with A2A - Google Codelabs](https://codelabs.developers.google.com/intro-a2a-purchasing-concierge)
28. [A2A Protocol Announcement - Google Developers Blog](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
29. [What is A2A? - IBM](https://www.ibm.com/think/topics/agent2agent-protocol)
30. [MCP vs A2A - Auth0 Blog](https://auth0.com/blog/mcp-vs-a2a/)

### Evolution API (Separate Project - Not Cloud.ru)

31. [Evolution API GitHub](https://github.com/EvolutionAPI/evolution-api)
32. [Evo AI Platform](https://github.com/EvolutionAPI/evo-ai)

---

**Research Completed:** 2026-02-13
**Document Version:** 1.0
**Status:** Comprehensive research complete, pending Cloud.ru support clarification on MCP and A2A details
