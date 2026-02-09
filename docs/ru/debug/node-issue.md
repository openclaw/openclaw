---
summary: Заметки о сбое Node + tsx «__name is not a function» и обходные пути
read_when:
  - Отладка dev-скриптов только для Node или сбоев в режиме watch
  - Исследование сбоев загрузчика tsx/esbuild в OpenClaw
title: "Сбой Node + tsx"
---

# Сбой Node + tsx «\_\_name is not a function»

## Краткое резюме

Запуск OpenClaw через Node с `tsx` падает при старте со следующим сообщением:

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

Это началось после переключения dev-скриптов с Bun на `tsx` (коммит `2871657e`, 2026-01-06). Тот же путь выполнения работал с Bun.

## Среда

- Node: v25.x (наблюдалось на v25.3.0)
- tsx: 4.21.0
- ОС: macOS (воспроизведение также вероятно на других платформах, где запускается Node 25)

## Воспроизведение (только Node)

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## Минимальное повторение в репозитории

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Проверка версии Node

- Node 25.3.0: падает
- Node 22.22.0 (Homebrew `node@22`): падает
- Node 24: здесь пока не установлен; требуется проверка

## Примечания / гипотеза

- `tsx` использует esbuild для преобразования TS/ESM. Опция esbuild `keepNames` генерирует вспомогательную функцию `__name` и оборачивает определения функций с помощью `__name(...)`.
- Сбой указывает на то, что `__name` существует, но в рантайме не является функцией, что подразумевает отсутствие или перезапись вспомогательной функции для этого модуля в пути загрузчика Node 25.
- Похожие проблемы со вспомогательной функцией `__name` сообщались у других потребителей esbuild, когда helper отсутствует или переписывается.

## История регрессии

- `2871657e` (2026-01-06): скрипты изменены с Bun на tsx, чтобы сделать Bun необязательным.
- До этого (путь с Bun) `openclaw status` и `gateway:watch` работали.

## Обходные пути

- Использовать Bun для dev-скриптов (текущий временный откат).

- Использовать Node + tsc в режиме watch, затем запускать скомпилированный вывод:

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- Подтверждено локально: `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` работает на Node 25.

- Отключить keepNames esbuild в загрузчике TS, если возможно (предотвращает вставку helper `__name`); tsx в настоящее время этого не предоставляет.

- Протестировать Node LTS (22/24) с `tsx`, чтобы проверить, специфична ли проблема для Node 25.

## Ссылки

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## Дальнейшие шаги

- Воспроизвести на Node 22/24, чтобы подтвердить регрессию Node 25.
- Протестировать nightly `tsx` или зафиксировать более раннюю версию, если известна регрессия.
- Если воспроизводится на Node LTS, оформить минимальное воспроизведение upstream с трассировкой стека `__name`.
