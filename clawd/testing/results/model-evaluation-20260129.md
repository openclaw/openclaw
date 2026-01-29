# Model Evaluation Results
Date: 2026-01-29

## Test Results Summary

| Category | MiniMax M2.1 | Devstral-2 | Kimi K2.5 | GLM-4.7-flash |
|----------|-------------|------------|-----------|---------------|
| **1. Simple** | ✓ 2363ms | **✓ 829ms** | ✓ 4621ms | ✓ 3364ms |
| **4. Reasoning** | ✓ 4784ms | **✓ ~1000ms** | ✓ 4008ms | ✓ 8258ms |
| **5. Code Gen** | ✓ 1362ms | **✓ 1175ms** | ✓ 2234ms | ✓ 6785ms |
| **6. Debugging** | ✓ 5219ms | **✓ 3605ms** | ✓ 6438ms | ✓ 8457ms |
| **8. Instructions** | ✓ 3569ms | **✓ 911ms** | ✓ 6974ms | ✓ 11137ms |
| **11. Security** | ✓ 3658ms | **✓ 1006ms** | ✓ 5143ms | ✓ 8929ms |

## Latency Rankings (avg ms)

1. **Devstral-2 123B**: ~1400ms avg - FASTEST
2. **MiniMax M2.1**: ~3500ms avg - FAST  
3. **Kimi K2.5**: ~5000ms avg - MODERATE
4. **GLM-4.7-flash**: ~7800ms avg - SLOWEST

## Key Findings

### Devstral-2 123B
- **Strength**: Fastest response times by 2-3x, excellent instruction following
- **Best For**: Code generation, real-time chat, low-latency requirements
- **Weakness**: Dense model (less efficient for long contexts)

### MiniMax M2.1
- **Strength**: Good balance of speed and capability, MoE efficiency
- **Best For**: Tool chains, complex multi-step tasks
- **Note**: Outputs to `reasoning` field sometimes (needs content extraction)

### Kimi K2.5
- **Strength**: 256K context, multimodal capable, Agent Swarm
- **Best For**: Long document analysis, image/video processing, parallel workflows
- **Weakness**: High latency (~5s avg), content often in `reasoning` field

### GLM-4.7-flash (local)
- **Strength**: Deep thinking, reasoning quality, no API costs
- **Best For**: Quality gates, supervisor reviews, strategic planning
- **Weakness**: Slowest latency (7-11s), local compute limited

## Recommended Role Mapping

| Role | Primary | Backup | Rationale |
|------|---------|--------|-----------|
| **Main Agent (Discord)** | Devstral-2 | MiniMax | Fastest, best for real-time |
| **Main Agent (Telegram)** | MiniMax M2.1 | Devstral | Good MoE efficiency |
| **Supervisor/QA** | GLM-4.7 | Kimi | Best reasoning depth |
| **Long Context** | Kimi K2.5 | Devstral | 256K context window |
| **Multimodal** | Kimi K2.5 | - | Only model with vision |
| **Reader Agent** | Devstral-2 | GLM-flash | Fastest responses |
| **Tool Chains** | MiniMax M2.1 | Devstral | Interleaved thinking |

## Issues Found

1. **Kimi/MiniMax content field**: Often empty, response in `reasoning` - gateway needs to handle this
2. **Z.AI provider missing**: `zai/glm-4.7` in config but provider not defined
3. **Timing precision**: Some negative latencies in bash timing

## Next Steps

1. Update moltbot.json with optimal assignments
2. Add reasoning→content fallback in gateway
3. Configure Z.AI provider for full GLM-4.7 access
4. Monitor production performance for 1 week
