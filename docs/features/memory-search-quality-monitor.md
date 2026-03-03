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
python3 memory-quality-monitor.py report

# Last 30 days
python3 memory-quality-monitor.py report 30
```

## 📈 Example Report

```
🌙 银月记忆搜索质量报告
============================================================
统计周期：7 天
总搜索次数：75
低质量搜索：12 (16.0%)
平均结果数：4.2
平均最高分：0.68

⚠️  最近低质量搜索:
  • "ECS 配置" → 1 结果，最高分 0.3
  • "博客密码" → 0 结果，最高分 0
  • "定时任务" → 2 结果，最高分 0.4
```

## 💡 Integration Suggestion for OpenClaw Core

This script currently requires manual integration. We suggest the OpenClaw team could:

1. **Auto-log searches**: Integrate logging directly into the `memory_search` tool
2. **Built-in report command**: Add `/memory-search-quality` CLI command
3. **Alert on poor quality**: Notify users when search quality drops below threshold
4. **Embedding model insights**: Track which models perform best for different query types

## 📁 Files

- `memory-quality-monitor.py` - Main monitoring script
- `memory/search-quality-log.jsonl` - Auto-generated log file (JSONL format)

## 🔧 Configuration

No configuration needed. Logs are stored at:
`~/.openclaw/workspace/memory/search-quality-log.jsonl`

## 📝 License

Same as OpenClaw project license.
