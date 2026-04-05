---
tags:
  - brigade
  - research
  - deep-research
category: domain-knowledge
difficulty: intermediate
training: true
created: 2026-06-30
---

# Research-Ops Brigade

Бригада исследований — отвечает за глубокий поиск, анализ и синтез информации.

## Состав цепочки

```
Researcher → Analyst → Summarizer
```

## Архитектура

```
DeepResearchPipeline
├── BraveSearch API → запросы по теме
├── URL extraction → extract_urls_from_search()
├── Domain filtering → _BLOCKED_DOMAINS / _HIGH_PRIORITY_DOMAINS
├── Page enrichment → enrich_with_full_content()
├── Content scoring → _content_quality_score()
├── Token budgeting → apply_token_budget()
└── Multi-perspective synthesis → MultiPerspectiveResearcher
```

## Правила

1. **Read-only**: не модифицирует код или файлы проекта
2. **Source quality**: приоритет авторитетным доменам (arxiv.org, github.com, docs.\* и др.)
3. **Blocked domains**: 28+ ненадежных доменов заблокированы (см. `_BLOCKED_DOMAINS`)
4. **Token budget**: ограничение на объем контента для каждого источника

## Глубина исследования

| Профиль | Источников | Итераций | Описание                                 |
| ------- | ---------- | -------- | ---------------------------------------- |
| simple  | 3-5        | 1        | Быстрый поиск по теме                    |
| medium  | 5-10       | 2        | Стандартный анализ                       |
| complex | 10-20      | 3+       | Глубокое исследование с cross-validation |

## Инструменты

- **BraveSearch**: основной поисковый движок
- **MultiPerspectiveResearcher**: анализ с разных точек зрения
- **EvidenceQualityScorer**: оценка качества доказательств
- **CrossValidator**: перекрёстная проверка фактов

## Модели

- **Researcher**: `arcee-ai/trinity-large-preview:free` (research)
- **Analyst**: `arcee-ai/trinity-large-preview:free` (tool_execution)
- **Summarizer**: `arcee-ai/trinity-mini:free` (expand)

## Связи

- Результаты сохраняются в SuperMemory (episodic)
- Паттерны успешного исследования → FeedbackLoop → `special_skills.json`
- Может быть вызвана по URL в задаче (семантическая декомпозиция)
