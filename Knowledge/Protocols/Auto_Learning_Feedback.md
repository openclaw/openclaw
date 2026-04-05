---
tags:
  - protocol
  - self-learning
  - auto-learning
category: domain-knowledge
difficulty: advanced
training: true
created: 2026-06-30
---

# Protocol: Auto-Learning Feedback Loop

Протокол автоматического обучения на основе паттернов из успешных коммитов.

## Триггер

После каждого успешного pipeline-коммита.

## Шаги

### 1. Извлечение diff

```
git diff HEAD~1 → _extract_added_code()
```

Парсинг `+` строк diff, фильтрация блоков >20 символов.

### 2. Анализ и скоринг

```
_score_pattern(code_block) → float (0.0 - 1.0)
```

Факторы:

- Base: 0.5
- Error handling (`try/except`, `Result<>`, `unwrap_or`): +0.1
- Async patterns (`async/await`): +0.05
- Type hints: +0.02 каждый (max +0.1)
- Comments ratio ≥5%: +0.1
- Reasonable length (5-50 lines): +0.1
- Too long (>50 lines): -0.05

### 3. Тегирование

```
_extract_tags(code) → List[str]
```

Автоматические теги: `async`, `error-handling`, `testing`, `api`, `parsing`, `caching`.

### 4. Сохранение

```
special_skills.json (max 200 patterns)
```

При превышении лимита — удаляются паттерны с наименьшим score.

### 5. Few-shot инъекция

Паттерны из `special_skills.json` подставляются как примеры в:

- System prompt ролей Coder, Executor_Architect, Test_Writer
- Context для Planner и Architect

## Верификация

- Каждый паттерн имеет `pattern_id` (SHA256 от кода)
- Дубликаты отфильтровываются
- `use_count` инкрементируется при каждом использовании
