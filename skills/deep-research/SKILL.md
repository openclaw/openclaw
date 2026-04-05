---
name: deep-research
description: Execute multi-iteration deep research with parallel search, fact verification, source triangulation, and confidence scoring. Use when the user needs thorough analysis, literature review, or evidence-based answers.
metadata:
  openclaw:
    emoji: "🔬"
    category: research
---

# Deep Research

Multi-perspective iterative research pipeline with adaptive stopping.

## Architecture

```
DeepResearchPipeline (src/research/_core.py)
├── _searcher.py — parallel: web + news + memory + academic
├── _analyzer.py — LLM-based scoring, contradictions, fact-check
└── _scraper.py  — page enrichment, domain priority, token budget
```

## Depth Profiles

| Profile | Iterations | Use when                         |
| ------- | ---------- | -------------------------------- |
| simple  | 2          | Quick fact lookups               |
| medium  | 4          | Standard research questions      |
| complex | 5          | Deep analysis, literature review |

## Key Components

- **EvidencePiece**: query, source_type (web/news/memory/academic), content, confidence (0-1)
- **ResearchState**: accumulated evidence, contradictions, verified facts, overall confidence
- **Source triangulation**: min 2 independent sources to verify claims
- **Token budget**: 96K chars max evidence → LLM synthesis

## Domain Filtering

High-priority sources (fetched first): Wikipedia, arXiv, GitHub, StackOverflow, official docs, academic journals, trusted news (Reuters, AP, BBC).

Blocked sources (excluded): social media (TikTok, Instagram, Facebook), content farms, link shorteners.

## Workflow

1. Decompose research question into sub-queries
2. Parallel search across web + news + memory
3. Page enrichment — fetch full content from top URLs
4. Evidence scoring + contradiction detection
5. Fact verification (cross-source)
6. LLM synthesis with confidence score
7. Repeat if confidence < threshold

## Integration

- MCP tools: `web_search`, `web_news_search`, `web_fetch`
- Memory: SuperMemory recall for cached knowledge
- Output: structured report with sources, confidence, contradictions
