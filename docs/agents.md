# Agent Personas

OpenClaw поддерживает систему агентных персон — специализированных ролей, которые адаптируют поведение бота под конкретную задачу.

## Быстрый старт

```
/agents          — список всех доступных персон
/agent <slug>    — активировать персону (например, /agent backend-architect)
```

При активации персона внедряет свой системный промпт, определяя стиль ответов, процесс работы и метрики качества.

## Структура каталога

```
agents/
├── design/
│   ├── image-prompt-engineer.md
│   ├── ui-designer.md
│   └── ux-architect.md
├── engineering/
│   ├── backend-architect.md
│   ├── code-reviewer.md
│   ├── devops-engineer.md
│   ├── frontend-engineer.md
│   ├── ml-engineer.md
│   ├── security-auditor.md
│   └── senior-developer.md
├── marketing/
│   ├── content-strategist.md
│   └── seo-specialist.md
├── product/
│   ├── product-manager.md
│   ├── product-strategist.md
│   └── trading-analyst.md
├── project-management/
│   └── project-manager.md
├── support/
│   └── technical-writer.md
└── testing/
    └── qa-engineer.md
```

## Формат файла персоны

Каждая персона — Markdown-файл с YAML-фронтматтером:

```yaml
---
name: Backend Architect
role: Senior Backend Engineer
description: Expert in Python async, API design, and system architecture.
tags: [python, backend, api, architecture]
---
<Системный промпт персоны — описание роли, процесс работы, артефакты, метрики>
```

### Поля

| Поле          | Обязательное | Описание                       |
| ------------- | ------------ | ------------------------------ |
| `name`        | Да           | Отображаемое имя персоны       |
| `role`        | Да           | Специализация / должность      |
| `description` | Да           | Краткое описание экспертизы    |
| `tags`        | Нет          | Список тегов для маршрутизации |

Категория (`category`) определяется по имени директории, а не по полю в YAML.

## Автоматическая маршрутизация

`AgentPersonaManager.suggest_for_prompt()` анализирует пользовательский запрос и предлагает наиболее подходящую персону на основе совпадения тегов и ключевых слов. Маршрутизация не является принудительной — пользователь всегда может выбрать персону вручную.

## Создание новой персоны

1. Создайте `.md` файл в соответствующей директории `agents/<category>/`
2. Заполните YAML-фронтматтер (name, role, description, tags)
3. Напишите системный промпт в теле файла
4. Перезапустите бота или вызовите `AgentPersonaManager.reset()` для перезагрузки

## API

```python
from src.agent_personas import AgentPersonaManager

manager = AgentPersonaManager()

# Список всех персон
all_personas = manager.list_all()

# Получить по slug
persona = manager.get("backend-architect")

# Список по категории
eng_personas = manager.list_by_category("engineering")

# Предложить персону для запроса
suggestion = manager.suggest_for_prompt("Оптимизируй SQL-запрос")

# Дополнить системный промпт
augmented = manager.augment_system_prompt(base_prompt, "ml-engineer")
```
