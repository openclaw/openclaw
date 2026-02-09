---
summary: "Плагины/расширения OpenClaw: обнаружение, конфигурация и безопасность"
read_when:
  - Добавление или изменение плагинов/расширений
  - Документирование правил установки или загрузки плагинов
title: "Плагины"
---

# Плагины (расширения)

## Быстрый старт (если вы впервые работаете с плагинами)

Плагин — это просто **небольшой модуль кода**, который расширяет OpenClaw
дополнительными возможностями (команды, инструменты и RPC шлюза Gateway).

Чаще всего плагины используются, когда нужна функция, которой пока нет в
ядре OpenClaw (или когда вы хотите держать необязательные возможности вне
основной установки).

Быстрый путь:

1. Посмотреть, что уже загружено:

```bash
openclaw plugins list
```

2. Установить официальный плагин (пример: Voice Call):

```bash
openclaw plugins install @openclaw/voice-call
```

3. Перезапустите Gateway (шлюз), затем настройте в разделе `plugins.entries.<id>.config`.

См. [Voice Call](/plugins/voice-call) как конкретный пример плагина.

## Доступные плагины (официальные)

- Microsoft Teams доступен только через плагин по состоянию на 2026.1.15; установите `@openclaw/msteams`, если используете Teams.
- Memory (Core) — встроенный плагин поиска памяти (включён по умолчанию через `plugins.slots.memory`)
- Memory (LanceDB) — встроенный плагин долгосрочной памяти (автовосстановление/захват; установите `plugins.slots.memory = "memory-lancedb"`)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (аутентификация провайдера) — в комплекте как `google-antigravity-auth` (по умолчанию отключено)
- Gemini CLI OAuth (аутентификация провайдера) — в комплекте как `google-gemini-cli-auth` (по умолчанию отключено)
- Qwen OAuth (аутентификация провайдера) — в комплекте как `qwen-portal-auth` (по умолчанию отключено)
- Copilot Proxy (аутентификация провайдера) — локальный мост VS Code Copilot Proxy; отличается от встроенного входа устройства `github-copilot` (в комплекте, по умолчанию отключено)

Плагины OpenClaw — это **модули TypeScript**, загружаемые во время выполнения через jiti. **Валидация конфига не выполняет код плагина**; вместо этого используется манифест плагина и JSON Schema. См. См. [manifestin Plugin](/plugins/manifest).

Плагины могут регистрировать:

- методы RPC шлюза Gateway
- HTTP‑обработчики шлюза Gateway
- инструменты агента
- команды CLI
- фоновые сервисы
- Необязательная проверка конфигурации
- **Skills** (путём перечисления каталогов `skills` в манифесте плагина)
- **Команды автоответа** (выполняются без вызова AI‑агента)

Плагины выполняются **в одном процессе** со шлюзом Gateway, поэтому рассматривайте их как доверенный код.
Руководство по созданию инструментов: [Plugin agent tools](/plugins/agent-tools).

## Вспомогательные функции времени выполнения

Плагины могут получать доступ к выбранным вспомогательным функциям ядра через `api.runtime`. Для телефонного TTS:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

Примечания:

- Использует конфигурацию ядра `messages.tts` (OpenAI или ElevenLabs).
- Возвращает PCM‑буфер аудио + частоту дискретизации. Плагины должны выполнять ресэмплинг/кодирование для провайдеров.
- Edge TTS не поддерживается для телефонии.

## Обнаружение и приоритеты

OpenClaw сканирует, по порядку:

1. Пути конфига

- `plugins.load.paths` (файл или каталог)

2. Расширения рабочего пространства

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. Глобальные расширения

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. Встроенные расширения (поставляются с OpenClaw, **по умолчанию отключены**)

- `<openclaw>/extensions/*`

Встроенные плагины необходимо явно включить через `plugins.entries.<id>.enabled`
или `openclaw plugins enable <id>`. Установленные плагины включены по умолчанию,
но могут быть отключены тем же способом.

Каждый плагин должен содержать файл `openclaw.plugin.json` в корне. Если путь
указывает на файл, корнем плагина считается каталог этого файла и он должен
содержать манифест.

Если несколько плагинов разрешаются к одному и тому же id, побеждает первый
найденный согласно порядку выше, а копии с более низким приоритетом игнорируются.

### Пакеты‑наборы

Каталог плагина может содержать `package.json` с `openclaw.extensions`:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

Каждая запись становится плагином. Если набор содержит несколько расширений,
id плагина становится `name/<fileBase>`.

Если ваш плагин импортирует npm‑зависимости, установите их в этом каталоге,
чтобы `node_modules` был доступен (`npm install` / `pnpm install`).

### Метаданные каталога каналов

Плагины каналов могут объявлять метаданные онбординга через `openclaw.channel` и
подсказки по установке через `openclaw.install`. Это позволяет держать ядро без данных каталога.

Пример:

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk (self-hosted)",
      "docsPath": "/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "Self-hosted chat via Nextcloud Talk webhook bots.",
      "order": 65,
      "aliases": ["nc-talk", "nc"]
    },
    "install": {
      "npmSpec": "@openclaw/nextcloud-talk",
      "localPath": "extensions/nextcloud-talk",
      "defaultChoice": "npm"
    }
  }
}
```

OpenClaw также может объединять **внешние каталоги каналов** (например, экспорт реестра MPM). Поместите JSON‑файл в один из следующих путей:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

Или укажите `OPENCLAW_PLUGIN_CATALOG_PATHS` (или `OPENCLAW_MPM_CATALOG_PATHS`), ссылаясь
на один или несколько JSON‑файлов (разделённых запятой/точкой с запятой/`PATH`). Каждый файл должен
содержать `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`.

## ID плагинов

ID плагинов по умолчанию:

- Пакеты‑наборы: `package.json` `name`
- Отдельный файл: базовое имя файла (`~/.../voice-call.ts` → `voice-call`)

Если плагин экспортирует `id`, OpenClaw использует его, но выдаёт предупреждение,
если он не совпадает с настроенным id.

## Конфигурация

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-extension"] },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } },
    },
  },
}
```

Поля:

- `enabled`: главный переключатель (по умолчанию: true)
- `allow`: список разрешённых (необязательно)
- `отказать`: отклонить список (опционально; запретить победы)
- `load.paths`: дополнительные файлы/каталоги плагинов
- `entries.<id>`: переключатели и конфиг для каждого плагина

Изменения конфига **требуют перезапуска шлюза Gateway**.

Правила валидации (строгие):

- Неизвестные id плагинов в `entries`, `allow`, `deny` или `slots` считаются **ошибками**.
- Неизвестные ключи `channels.<id>` считаются **ошибками**, если только манифест плагина
  не объявляет id канала.
- Конфиг плагина валидируется с использованием JSON Schema, встроенной в
  `openclaw.plugin.json` (`configSchema`).
- Если плагин отключён, его конфиг сохраняется и выдаётся **предупреждение**.

## Слоты плагинов (эксклюзивные категории)

Некоторые категории плагинов являются **эксклюзивными** (одновременно активен только один). Используйте
`plugins.slots`, чтобы выбрать, какой плагин владеет слотом:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

Если несколько плагинов объявляют `kind: "memory"`, загружается только выбранный. Остальные
отключаются с диагностикой.

## UI управления (схема + метки)

UI управления использует `config.schema` (JSON Schema + `uiHints`) для отображения более удобных форм.

OpenClaw дополняет `uiHints` во время выполнения на основе обнаруженных плагинов:

- Добавляет метки для каждого плагина для `plugins.entries.<id>` / `.enabled` / `.config`
- Объединяет необязательные подсказки полей конфига, предоставленные плагином, в:
  `plugins.entries.<id>.config.<field>`

Если вы хотите, чтобы поля конфига вашего плагина отображались с хорошими метками/плейсхолдерами
(и чтобы секреты помечались как чувствительные), предоставьте `uiHints`
рядом с вашей JSON Schema в манифесте плагина.

Пример:

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": { "type": "string" },
      "region": { "type": "string" }
    }
  },
  "uiHints": {
    "apiKey": { "label": "API Key", "sensitive": true },
    "region": { "label": "Region", "placeholder": "us-east-1" }
  }
}
```

## CLI

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins install <path>                 # copy a local file/dir into ~/.openclaw/extensions/<id>
openclaw plugins install ./extensions/voice-call # relative path ok
openclaw plugins install ./plugin.tgz           # install from a local tarball
openclaw plugins install ./plugin.zip           # install from a local zip
openclaw plugins install -l ./extensions/voice-call # link (no copy) for dev
openclaw plugins install @openclaw/voice-call # install from npm
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` работает только для npm‑установок, отслеживаемых в `plugins.installs`.

Плагины также могут регистрировать собственные команды верхнего уровня
(пример: `openclaw voicecall`).

## API плагинов (обзор)

Плагины экспортируют либо:

- Функцию: `(api) => { ... }`
- Объект: `{ id, name, configSchema, register(api) { ... } }`

## Хуки плагинов

Плагины могут поставлять хуки и регистрировать их во время выполнения. Это позволяет плагину
включать событийную автоматизацию без отдельной установки набора хуков.

### Пример

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

Примечания:

- Каталоги хуков следуют обычной структуре хуков (`HOOK.md` + `handler.ts`).
- Правила применимости хуков по‑прежнему действуют (ОС/bins/переменные окружения/требования конфига).
- Хуки, управляемые плагином, отображаются в `openclaw hooks list` с `plugin:<id>`.
- Вы не можете включать/отключать хуки, управляемые плагином, через `openclaw hooks`; вместо этого включайте/отключайте сам плагин.

## Плагины провайдеров (аутентификация моделей)

Плагины могут регистрировать **потоки аутентификации провайдеров моделей**, чтобы пользователи
могли выполнять настройку OAuth или API‑ключей внутри OpenClaw (без внешних скриптов).

Зарегистрируйте провайдера через `api.registerProvider(...)`. Каждый провайдер предоставляет один
или несколько методов аутентификации (OAuth, API‑ключ, код устройства и т. д.). Эти методы обеспечивают работу:

- `openclaw models auth login --provider <id> [--method <id>]`

Пример:

```ts
api.registerProvider({
  id: "acme",
  label: "AcmeAI",
  auth: [
    {
      id: "oauth",
      label: "OAuth",
      kind: "oauth",
      run: async (ctx) => {
        // Run OAuth flow and return auth profiles.
        return {
          profiles: [
            {
              profileId: "acme:default",
              credential: {
                type: "oauth",
                provider: "acme",
                access: "...",
                refresh: "...",
                expires: Date.now() + 3600 * 1000,
              },
            },
          ],
          defaultModel: "acme/opus-1",
        };
      },
    },
  ],
});
```

Примечания:

- `run` получает `ProviderAuthContext` с вспомогательными функциями
  `prompter`, `runtime`, `openUrl` и `oauth.createVpsAwareHandlers`.
- Возвращайте `configPatch`, когда нужно добавить модели по умолчанию или конфиг провайдера.
- Возвращайте `defaultModel`, чтобы `--set-default` мог обновить значения по умолчанию агента.

### Регистрация канала обмена сообщениями

Плагины могут регистрировать **плагины каналов**, которые ведут себя как встроенные каналы
(WhatsApp, Telegram и т. д.). Конфигурация канала размещается под `channels.<id>` и
валидируется кодом вашего плагина канала.

```ts
const myChannel = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "demo channel plugin.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async () => ({ ok: true }),
  },
};

export default function (api) {
  api.registerChannel({ plugin: myChannel });
}
```

Примечания:

- Размещайте конфиг под `channels.<id>` (а не под `plugins.entries`).
- `meta.label` используется для меток в списках CLI/UI.
- `meta.aliases` добавляет альтернативные id для нормализации и ввода в CLI.
- `meta.preferOver` перечисляет id каналов, которые следует пропустить при авто‑включении, если оба настроены.
- `meta.detailLabel` и `meta.systemImage` позволяют UI показывать более богатые метки/иконки каналов.

### Создание нового канала обмена сообщениями (пошагово)

Используйте это, когда вам нужен **новый чат‑интерфейс** («канал сообщений»), а не провайдер модели.
Документация по провайдерам моделей находится в `/providers/*`.

1. Выберите id и форму конфига

- Вся конфигурация канала размещается под `channels.<id>`.
- Для многоаккаунтных конфигураций предпочтительнее `channels.<id>.accounts.<accountId>`.

2. Определите метаданные канала

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` управляют списками CLI/UI.
- `meta.docsPath` должен указывать на страницу документации, например `/channels/<id>`.
- `meta.preferOver` позволяет плагину заменить другой канал (авто‑включение предпочитает его).
- `meta.detailLabel` и `meta.systemImage` используются UI для детального текста/иконок.

3. Реализуйте обязательные адаптеры

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (типы чатов, медиа, треды и т. д.)
- `outbound.deliveryMode` + `outbound.sendText` (для базовой отправки)

4. Добавьте необязательные адаптеры по мере необходимости

- `setup` (мастер), `security` (политика ЛС), `status` (здоровье/диагностика)
- `gateway` (start/stop/login), `mentions`, `threading`, `streaming`
- `actions` (действия с сообщениями), `commands` (поведение нативных команд)

5. Зарегистрируйте канал в вашем плагине

- `api.registerChannel({ plugin })`

Минимальный пример конфига:

```json5
{
  channels: {
    acmechat: {
      accounts: {
        default: { token: "ACME_TOKEN", enabled: true },
      },
    },
  },
}
```

Минимальный плагин канала (только исходящие сообщения):

```ts
const plugin = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "AcmeChat messaging channel.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text }) => {
      // deliver `text` to your channel here
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

Загрузите плагин (каталог расширений или `plugins.load.paths`), перезапустите шлюз,
затем настройте `channels.<id>` в вашем конфиге.

### Инструменты агента

См. отдельное руководство: [Plugin agent tools](/plugins/agent-tools).

### Регистрация метода RPC шлюза Gateway

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### Регистрация команд CLI

```ts
export default function (api) {
  api.registerCli(
    ({ program }) => {
      program.command("mycmd").action(() => {
        console.log("Hello");
      });
    },
    { commands: ["mycmd"] },
  );
}
```

### Регистрация команд автоответа

Плагины могут регистрировать пользовательские slash‑команды, которые выполняются **без вызова
AI‑агента**. Это полезно для команд‑переключателей, проверок статуса или быстрых действий,
которые не требуют обработки LLM.

```ts
export default function (api) {
  api.registerCommand({
    name: "mystatus",
    description: "Show plugin status",
    handler: (ctx) => ({
      text: `Plugin is running! Channel: ${ctx.channel}`,
    }),
  });
}
```

Контекст обработчика команд:

- `senderId`: ID отправителя (если доступно)
- `channel`: канал, в котором была отправлена команда
- `isAuthorizedSender`: является ли отправитель авторизованным пользователем
- `args`: аргументы, переданные после команды (если `acceptsArgs: true`)
- `commandBody`: полный текст команды
- `config`: текущий конфиг OpenClaw

Параметры команды:

- `name`: имя команды (без ведущего `/`)
- `description`: текст справки, отображаемый в списках команд
- `acceptsArgs`: принимает ли команда аргументы (по умолчанию: false). Если false и аргументы переданы, команда не будет сопоставлена и сообщение перейдёт к другим обработчикам
- `requireAuth`: требуется ли авторизованный отправитель (по умолчанию: true)
- `handler`: функция, возвращающая `{ text: string }` (может быть async)

Пример с авторизацией и аргументами:

```ts
api.registerCommand({
  name: "setmode",
  description: "Set plugin mode",
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx) => {
    const mode = ctx.args?.trim() || "default";
    await saveMode(mode);
    return { text: `Mode set to: ${mode}` };
  },
});
```

Примечания:

- Команды плагинов обрабатываются **до** встроенных команд и AI‑агента
- Команды регистрируются глобально и работают во всех каналах
- Имена команд нечувствительны к регистру (`/MyStatus` соответствует `/mystatus`)
- Имена команд должны начинаться с буквы и содержать только буквы, цифры, дефисы и подчёркивания
- Зарезервированные имена команд (такие как `help`, `status`, `reset` и т. д.) не могут быть переопределены плагинами
- Дублирующая регистрация команд между плагинами завершится диагностической ошибкой

### Регистрация фоновых сервисов

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## Соглашения об именовании

- Методы Gateway: `pluginId.action` (пример: `voicecall.status`)
- Инструменты: `snake_case` (пример: `voice_call`)
- Команды CLI: kebab или camel, но избегайте конфликтов с командами ядра

## Skills

Плагины могут поставлять skill в репозитории (`skills/<name>/SKILL.md`).
Включите его через `plugins.entries.<id>.enabled` (или другие гейты конфига) и убедитесь,
что он присутствует в локациях skills вашего рабочего пространства/управляемых skills.

## Распространение (npm)

Рекомендуемая упаковка:

- Основной пакет: `openclaw` (этот репозиторий)
- Плагины: отдельные npm‑пакеты под `@openclaw/*` (пример: `@openclaw/voice-call`)

Контракт публикации:

- `package.json` плагина должен включать `openclaw.extensions` с одним или несколькими входными файлами.
- Входные файлы могут быть `.js` или `.ts` (jiti загружает TS во время выполнения).
- `openclaw plugins install <npm-spec>` использует `npm pack`, извлекает в `~/.openclaw/extensions/<id>/` и включает его в конфиге.
- Стабильность ключей конфига: пакеты с областью видимости нормализуются к **безобластному** id для `plugins.entries.*`.

## Пример плагина: Voice Call

Этот репозиторий включает плагин голосовых вызовов (Twilio или лог‑fallback):

- Исходный код: `extensions/voice-call`
- Skill: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- Инструмент: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- Конфиг (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (необязательно `statusCallbackUrl`, `twimlUrl`)
- Конфиг (dev): `provider: "log"` (без сети)

См. [Voice Call](/plugins/voice-call) и `extensions/voice-call/README.md` для настройки и использования.

## Примечания по безопасности

Плагины выполняются в одном процессе со шлюзом Gateway. Рассматривайте их как доверенный код:

- Устанавливайте только те плагины, которым доверяете.
- Предпочитайте списки разрешённых `plugins.allow`.
- Перезапускайте шлюз Gateway после изменений.

## Тестирование плагинов

Плагины могут (и должны) поставляться с тестами:

- Плагины внутри репозитория могут хранить тесты Vitest под `src/**` (пример: `src/plugins/voice-call.plugin.test.ts`).
- Плагины, публикуемые отдельно, должны запускать собственный CI (lint/build/test) и проверять,
  что `openclaw.extensions` указывает на собранную точку входа (`dist/index.js`).
