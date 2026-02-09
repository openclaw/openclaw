---
summary: "Схема конфига Skills и примеры"
read_when:
  - Добавление или изменение конфига Skills
  - Корректировка встроенного allowlist или поведения установки
title: "Конфиг Skills"
---

# Конфиг Skills

Вся конфигурация, связанная со Skills, находится под `skills` в `~/.openclaw/openclaw.json`.

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

## Поля

- `allowBundled`: необязательный allowlist только для **встроенных** Skills. Если задан, доступны
  только встроенные Skills из списка (управляемые/Skills рабочего пространства не затрагиваются).
- `load.extraDirs`: дополнительные каталоги Skills для сканирования (наименьший приоритет).
- `load.watch`: отслеживать папки Skills и обновлять снимок Skills (по умолчанию: true).
- `load.watchDebounceMs`: debounce для событий наблюдателя Skills в миллисекундах (по умолчанию: 250).
- `install.preferBrew`: предпочитать установщики brew при наличии (по умолчанию: true).
- `install.nodeManager`: предпочтение установщика Node (`npm` | `pnpm` | `yarn` | `bun`, по умолчанию: npm).
  Это влияет только на **установку Skills**; рантайм Gateway (шлюз) по‑прежнему должен быть Node
  (Bun не рекомендуется для WhatsApp/Telegram).
- `entries.<skillKey>`: переопределения для каждого Skill.

Поля навыков:

- `enabled`: установите `false`, чтобы отключить Skill, даже если он встроенный/установлен.
- `env`: переменные окружения, внедряемые для запуска агента (только если ещё не заданы).
- `apiKey`: необязательное удобство для Skills, которые объявляют основную переменную окружения.

## Примечания

- Ключи под `entries` по умолчанию сопоставляются с именем Skill. Если Skill определяет
  `metadata.openclaw.skillKey`, используйте вместо этого этот ключ.
- Изменения в Skills подхватываются на следующем ходе агента, когда наблюдатель включён.

### Sandboxed Skills и переменные окружения

Когда сеанс **sandboxed**, процессы Skills запускаются внутри Docker. Sandbox
**не** наследует `process.env` хоста.

Используйте один из вариантов:

- `agents.defaults.sandbox.docker.env` (или для каждого агента `agents.list[].sandbox.docker.env`)
- запеките переменные окружения в ваш кастомный образ sandbox

Глобальные `env` и `skills.entries.<skill>.env/apiKey` применяются только к запускам на **хосте**.
