---
name: grok-x-analyzer
description: Dynamic, Grok 4.3-inspired analyzer for X (Twitter) posts, threads, trends, user activity, and related data. Use when users mention X/Twitter URLs/posts, ask to 'analyze', 'summarize', 'check engagement' on X content, extract insights from trends/replies, or need project-like structure breakdowns (e.g., thread hierarchies, post folders). Triggers on X data tasks for seamless, hidden activation like Grok skills.
---

# Grok X Analyzer

## Overview

Emulates Grok 4.3's dynamic 'Skills' for X: auto-fetch posts/threads/trends via xurl/web tools, analyze structure/engagement/insights (e.g., folder-like hierarchies, key replies), and generate hidden summaries. Prioritize low-token flows; chain to subagents for deep dives.

## Quick Start

1. **Match Context**: Trigger on X URLs/posts (e.g., status/123), 'analyze thread', 'X trends', 'post engagement'.
2. **Fetch Raw**: Use `xurl read POST_ID` or `web_fetch` for screenshots/HTML.
3. **Analyze**: Extract structure (replies as 'folder'), engagement, insights.
4. **Output**: Hidden skill style—direct insights, no narration unless asked.

Example User: 'Analyze https://x.com/testingcatalog/status/2045985840292082093'
→ Fetch post/replies → 'Key insight: Grok 4.3 skills focus on dynamic X data tools.'

## Workflow

### 1. Parse Input

- Extract POST_ID from URL (e.g., /status/2045985840292082093 → 2045985840292082093).
- Fallback: `web_fetch URL` + parse text.

### 2. Fetch Data

```bash
xurl read POST_ID  # Post + metrics
xurl replies POST_ID -n 20  # Thread/replies
xurl search 'keyword' -n 10  # Context
```

If unauth: `web_search 'site:x.com status/POST_ID'`.

### 3. Structure Analysis (Grok-Style)

- **📁 Post 'Folder'**: Author, text, media, stats (views/likes/reposts).
- **🧠 Thread Hierarchy**: Parent → replies (tree view).
- **💡 Insights**: Sentiment, trends, key quotes.
- **🎯 Engagement**: Growth, viral potential.

### 4. Chain if Deep

Spawn `sessions_spawn(runtime=subagent, task='Deep dive on [insight]')`.

## Resources

### scripts/

x_analyzer.py: Fetch post/replies via xurl (fallback web), JSON output with 📁🧠💡🎯 structure.

### references/

xurl.md: xurl CLI cheatsheet + auth notes.
