# Memory Search Quality Monitor

## 🎯 Purpose

This script monitors the quality of `memory_search` operations by logging search metrics and detecting poor-quality searches (silent failures).

## 📊 Metrics Tracked

- **Search query**: What the user searched for
- **Result count**: How many results were returned
- **Max similarity score**: The highest relevance score among results
- **Quality flag**: Automatically marks searches as "poor" if:
  - Results < 3, OR
  - Max score < 0.5

## 🚀 Usage

### Log a search result
```python
from memory_quality_monitor import log_search_result

# After calling memory_search
results = memory_search("some query")
log_search_result(
    query="some query",
    result_count=len(results),
    max_score=max(r.score for r in results) if results else 0
)
```

### Generate quality report
```bash
# Last 7 days (default)
python3 memory_quality_monitor.py report

# Last 30 days
python3 memory_quality_monitor.py report 30
```

## 📈 Example Report

```
🌙 Memory Search Quality Report
============================================================
Period: 7 days
Total searches: 75
Poor quality searches: 12 (16.0%)
Avg results per search: 4.2
Avg max score: 0.68

⚠️  Recent poor quality searches:
  • "ECS config" → 1 result, max score 0.3
  • "blog password" → 0 results, max score 0
  • "scheduled tasks" → 2 results, max score 0.4
```

## 💡 Integration Suggestion for OpenClaw Core

This script currently requires manual integration. We suggest the OpenClaw team could:

1. **Auto-log searches**: Integrate logging directly into the `memory_search` tool
2. **Built-in report command**: Add `/memory-search-quality` CLI command
3. **Alert on poor quality**: Notify users when search quality drops below threshold
4. **Embedding model insights**: Track which models perform best for different query types

## 📁 Files

- `memory_quality_monitor.py` - Main monitoring script
- `memory/search-quality-log.jsonl` - Auto-generated log file (JSONL format)

## 🔧 Configuration

No configuration needed. Logs are stored at:
`~/.openclaw/workspace/memory/search-quality-log.jsonl`

## 📝 License

Same as OpenClaw project license.
