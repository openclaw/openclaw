# CLI-Centric vs Native Mode: Token Battle Benchmark

## Setup

- **Model**: qwen3.5-plus (via DashScope Anthropic-compatible API)
- **Measurement**: Transparent SSE proxy capturing `message_delta` usage (including `cache_read` + `cache_write` tokens)
- **Task**: 7-step system report (exec×4 + read×2 + write×1), each step requires tool execution
- **Sessions**: Fully cleaned between runs (sessions.json + all .jsonl files)

## Results

| Metric                  | NATIVE (21 tools) | CLI (4 tools) | Savings |
| ----------------------- | ----------------- | ------------- | ------- |
| Schema Chars/turn       | 14,872            | 3,668         | **75%** |
| Turns                   | 8                 | 8             | Same    |
| **Prompt Tokens Total** | **106,200**       | **77,196**    | **27%** |
| Output Tokens Total     | 1,798             | 2,272         | -26%    |
| **Grand Total**         | **107,998**       | **79,468**    | **26%** |
| Req Body Chars Total    | 364,294           | 263,052       | **28%** |
| Avg Prompt/Turn         | ~13,275           | ~9,650        | **27%** |

## Per-Turn Detail

### NATIVE Mode (21 tools)

| Turn | prompt_total | output | cache_read | cache_write |
| ---- | ------------ | ------ | ---------- | ----------- |
| 1    | 12,005       | 95     | 11,999     | 0           |
| 2    | 12,263       | 108    | 11,999     | 258         |
| 3    | 12,398       | 100    | 12,257     | 135         |
| 4    | 12,587       | 110    | 12,392     | 189         |
| 5    | 13,154       | 853    | 12,581     | 567         |
| 6    | 14,038       | 89     | 13,148     | 884         |
| 7    | 14,825       | 81     | 14,032     | 787         |
| 8    | 14,930       | 362    | 14,819     | 105         |

### CLI-Centric Mode (4 tools)

| Turn | prompt_total | output | cache_read | cache_write |
| ---- | ------------ | ------ | ---------- | ----------- |
| 1    | 8,054        | 190    | 7,857      | 191         |
| 2    | 8,407        | 89     | 8,048      | 353         |
| 3    | 8,523        | 95     | 8,401      | 116         |
| 4    | 8,709        | 145    | 8,517      | 186         |
| 5    | 9,309        | 1,251  | 8,703      | 600         |
| 6    | 10,591       | 77     | 9,303      | 1,282       |
| 7    | 11,755       | 69     | 10,585     | 1,164       |
| 8    | 11,848       | 356    | 11,749     | 93          |

## Key Findings

1. **Stable ~3,000-4,000 prompt token savings per turn** from tools schema reduction (15,117→3,720 chars)
2. **Cumulative 29,004 prompt tokens saved (27%)** across 8 turns
3. CLI mode output tokens slightly higher (+26%) due to CLI invocation overhead — far outweighed by prompt savings
4. Gap narrows slightly as conversation history grows (fixed schema delta becomes smaller fraction), but absolute savings remain ~3,000 tokens/turn
5. **Theoretical scaling**: with more tools (50+), savings would be proportionally larger since native mode schema grows linearly while CLI mode stays at ~3,700 chars
