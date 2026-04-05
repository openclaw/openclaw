---
tags:
  - protocol
  - self-learning
  - knowledge-growth
category: domain-knowledge
difficulty: advanced
training: true
created: 2026-06-30
---

# Protocol: Knowledge Self-Growth

Протокол автоматического наращивания базы знаний Obsidian-волта.

## Триггер

Периодический (после N pipeline-запусков) или по запросу Archivist-роли.

## Шаги

### 1. Gap Analysis

Скрипт `knowledge_writer.py` анализирует:

- Какие сущности упоминаются в коде/коммитах, но нет в `Knowledge/Concepts/`
- Какие теги в `special_skills.json` не имеют соответствующих Concept-документов
- Что изменилось в архитектуре (новые модули, удалённые компоненты)

### 2. Генерация заметки

Для каждого обнаруженного пробела:

```python
# Template
template = {
    "frontmatter": {
        "tags": extracted_tags,
        "category": "domain-knowledge",
        "difficulty": "intermediate",
        "training": True,
        "created": today,
        "auto_generated": True,
    },
    "body": f"# {topic}\n\n{summary}\n\n## Связи\n\n{wikilinks}"
}
```

### 3. Wikilink injection

Новая заметка автоматически связывается через `[[wikilinks]]`:

- С родительской Concept-заметкой (если есть)
- С MOC.md (обновление секции)
- С BRAIN.md (запись в changelog)

### 4. Training data generation

Если `training: true` → автовызов:

```bash
python scripts/vault_to_training.py --file Knowledge/Concepts/{new_file}.md
```

### 5. Верификация

- `auto_generated: true` в frontmatter помечает авто-заметки
- Archivist-роль может пометить для ручной проверки
- Learning_Log.md пополняется записью о новой заметке

## Критерии качества

- Заметка должна содержать ≥3 H2-секции
- Хотя бы 1 `[[wikilink]]` на существующую заметку
- Tags не пустые
- Category из допустимого списка: `domain-knowledge`, `code-reference`, `troubleshooting`
