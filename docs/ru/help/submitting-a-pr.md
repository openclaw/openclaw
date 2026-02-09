---
summary: "Как отправить PR с высоким сигналом"
title: "Отправка PR"
---

Хорошие PR легко рецензировать: рецензенты должны быстро понимать намерение, проверять поведение и безопасно принимать изменения. В этом руководстве описаны лаконичные PR с высоким сигналом для рецензирования людьми и LLM.

## Что делает PR хорошим

- [ ] Объясните проблему, почему она важна, и какое изменение предлагается.
- [ ] Держите изменения сфокусированными. Избегайте широких рефакторингов.
- [ ] Кратко опишите изменения, видимые пользователю/в конфигурации/значениях по умолчанию.
- [ ] Перечислите покрытие тестами, пропуски и причины.
- [ ] Добавьте доказательства: логи, скриншоты или записи (UI/UX).
- [ ] Кодовое слово: поместите «lobster-biscuit» в описание PR, если вы прочитали это руководство.
- [ ] Запустите/исправьте соответствующие команды `pnpm` перед созданием PR.
- [ ] Выполните поиск по кодовой базе и GitHub на предмет связанной функциональности/задач/исправлений.
- [ ] Основывайте утверждения на доказательствах или наблюдениях.
- [ ] Хороший заголовок: глагол + область + результат (например, `Docs: add PR and issue templates`).

Будьте краткими; краткость при рецензировании важнее грамматики. Опускайте все неприменимые разделы.

### Базовые команды валидации (запустите/исправьте сбои для вашего изменения)

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Изменения протокола: `pnpm protocol:check`

## Прогрессивное раскрытие

- Сверху: краткое резюме/намерение
- Далее: изменения/риски
- Далее: тесты/проверка
- В конце: реализация/доказательства

## Распространённые типы PR: детали

- [ ] Исправление: добавьте воспроизведение, первопричину, проверку.
- [ ] Функция: добавьте сценарии использования, поведение/демо/скриншоты (UI).
- [ ] Рефакторинг: укажите «без изменения поведения», перечислите, что перемещено/упрощено.
- [ ] Chore: укажите причину (например, время сборки, CI, зависимости).
- [ ] Документация: контекст «до/после», ссылка на обновлённую страницу, запустите `pnpm format`.
- [ ] Тесты: какой пробел закрыт; как это предотвращает регрессии.
- [ ] Производительность: добавьте метрики «до/после» и способ измерения.
- [ ] UX/UI: скриншоты/видео, отметьте влияние на доступность.
- [ ] Инфраструктура/Сборка: окружения/валидация.
- [ ] Безопасность: кратко опишите риск, воспроизведение, проверку; без конфиденциальных данных. Только обоснованные утверждения.

## Checklist

- [ ] Чётко сформулированная проблема/намерение
- [ ] Сфокусированный объём
- [ ] Перечень изменений поведения
- [ ] Перечень и результаты тестов
- [ ] Шаги ручного тестирования (когда применимо)
- [ ] Отсутствие секретов/приватных данных
- [ ] Основано на доказательствах

## Общий шаблон PR

```md
#### Summary

#### Behavior Changes

#### Codebase and GitHub Search

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort (self-reported):
- Agent notes (optional, cite evidence):
```

## Шаблоны типов PR (замените на ваш тип)

### Исправление

```md
#### Summary

#### Repro Steps

#### Root Cause

#### Behavior Changes

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Функция

```md
#### Summary

#### Use Cases

#### Behavior Changes

#### Existing Functionality Check

- [ ] I searched the codebase for existing functionality.
      Searches performed (1-3 bullets):
  -
  -

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Рефакторинг

```md
#### Summary

#### Scope

#### No Behavior Change Statement

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Chore/Поддержка

```md
#### Summary

#### Why This Matters

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Документация

```md
#### Summary

#### Pages Updated

#### Before/After

#### Formatting

pnpm format

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Тесты

```md
#### Summary

#### Gap Covered

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Perf

```md
#### Summary

#### Baseline

#### After

#### Measurement Method

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### UX/UI

```md
#### Summary

#### Screenshots or Video

#### Accessibility Impact

#### Tests

#### Manual Testing

### Prerequisites

-

### Steps

1.
2. **Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Инфраструктура/Сборка

```md
#### Summary

#### Environments Affected

#### Validation Steps

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Безопасность

```md
#### Summary

#### Risk Summary

#### Repro Steps

#### Mitigation or Fix

#### Verification

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```
