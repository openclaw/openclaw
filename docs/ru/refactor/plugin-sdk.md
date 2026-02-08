---
summary: «План: единый чистый SDK плагинов + runtime для всех коннекторов сообщений»
read_when:
  - «Определение или рефакторинг архитектуры плагинов»
  - «Миграция коннекторов каналов на SDK/runtime плагинов»
title: «Рефакторинг SDK плагинов»
x-i18n:
  source_path: refactor/plugin-sdk.md
  source_hash: 1f3519f43632fcac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:56:01Z
---

# План рефакторинга SDK плагинов + Runtime

Цель: каждый коннектор сообщений — это плагин (в комплекте или внешний), использующий один стабильный API.
Ни один плагин не импортирует напрямую из `src/**`. Все зависимости проходят через SDK или runtime.

## Почему сейчас

- Текущие коннекторы смешивают подходы: прямые импорты из core, мосты только для dist и кастомные хелперы.
- Это делает обновления хрупкими и блокирует чистую поверхность для внешних плагинов.

## Целевая архитектура (два слоя)

### 1) SDK плагинов (время компиляции, стабильный, публикуемый)

Область: типы, хелперы и утилиты конфигурации. Без состояния runtime, без побочных эффектов.

Содержимое (примеры):

- Типы: `ChannelPlugin`, адаптеры, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.
- Хелперы конфигурации: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,
  `applyAccountNameToChannelSection`.
- Хелперы сопряжения: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.
- Хелперы онбординга: `promptChannelAccessConfig`, `addWildcardAllowFrom`, типы онбординга.
- Хелперы параметров инструментов: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.
- Хелпер ссылок на документацию: `formatDocsLink`.

Поставка:

- Публиковать как `openclaw/plugin-sdk` (или экспортировать из core под `openclaw/plugin-sdk`).
- Semver с явными гарантиями стабильности.

### 2) Runtime плагинов (поверхность исполнения, внедряемая)

Область: всё, что касается поведения core во время выполнения.
Доступ осуществляется через `OpenClawPluginApi.runtime`, поэтому плагины никогда не импортируют `src/**`.

Предлагаемая поверхность (минимальная, но полная):

```ts
export type PluginRuntime = {
  channel: {
    text: {
      chunkMarkdownText(text: string, limit: number): string[];
      resolveTextChunkLimit(cfg: OpenClawConfig, channel: string, accountId?: string): number;
      hasControlCommand(text: string, cfg: OpenClawConfig): boolean;
    };
    reply: {
      dispatchReplyWithBufferedBlockDispatcher(params: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: {
            text?: string;
            mediaUrls?: string[];
            mediaUrl?: string;
          }) => void | Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        };
      }): Promise<void>;
      createReplyDispatcherWithTyping?: unknown; // adapter for Teams-style flows
    };
    routing: {
      resolveAgentRoute(params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: "dm" | "group" | "channel"; id: string };
      }): { sessionKey: string; accountId: string };
    };
    pairing: {
      buildPairingReply(params: { channel: string; idLine: string; code: string }): string;
      readAllowFromStore(channel: string): Promise<string[]>;
      upsertPairingRequest(params: {
        channel: string;
        id: string;
        meta?: { name?: string };
      }): Promise<{ code: string; created: boolean }>;
    };
    media: {
      fetchRemoteMedia(params: { url: string }): Promise<{ buffer: Buffer; contentType?: string }>;
      saveMediaBuffer(
        buffer: Uint8Array,
        contentType: string | undefined,
        direction: "inbound" | "outbound",
        maxBytes: number,
      ): Promise<{ path: string; contentType?: string }>;
    };
    mentions: {
      buildMentionRegexes(cfg: OpenClawConfig, agentId?: string): RegExp[];
      matchesMentionPatterns(text: string, regexes: RegExp[]): boolean;
    };
    groups: {
      resolveGroupPolicy(
        cfg: OpenClawConfig,
        channel: string,
        accountId: string,
        groupId: string,
      ): {
        allowlistEnabled: boolean;
        allowed: boolean;
        groupConfig?: unknown;
        defaultConfig?: unknown;
      };
      resolveRequireMention(
        cfg: OpenClawConfig,
        channel: string,
        accountId: string,
        groupId: string,
        override?: boolean,
      ): boolean;
    };
    debounce: {
      createInboundDebouncer<T>(opts: {
        debounceMs: number;
        buildKey: (v: T) => string | null;
        shouldDebounce: (v: T) => boolean;
        onFlush: (entries: T[]) => Promise<void>;
        onError?: (err: unknown) => void;
      }): { push: (v: T) => void; flush: () => Promise<void> };
      resolveInboundDebounceMs(cfg: OpenClawConfig, channel: string): number;
    };
    commands: {
      resolveCommandAuthorizedFromAuthorizers(params: {
        useAccessGroups: boolean;
        authorizers: Array<{ configured: boolean; allowed: boolean }>;
      }): boolean;
    };
  };
  logging: {
    shouldLogVerbose(): boolean;
    getChildLogger(name: string): PluginLogger;
  };
  state: {
    resolveStateDir(cfg: OpenClawConfig): string;
  };
};
```

Примечания:

- Runtime — единственный способ доступа к поведению core.
- SDK намеренно небольшой и стабильный.
- Каждый метод runtime сопоставляется с существующей реализацией core (без дублирования).

## План миграции (поэтапно, безопасно)

### Фаза 0: каркас

- Ввести `openclaw/plugin-sdk`.
- Добавить `api.runtime` в `OpenClawPluginApi` с поверхностью выше.
- Сохранять существующие импорты в течение переходного окна (предупреждения о депрекации).

### Фаза 1: очистка мостов (низкий риск)

- Заменить `core-bridge.ts` для каждого расширения на `api.runtime`.
- Сначала мигрировать BlueBubbles, Zalo, Zalo Personal (уже близки).
- Удалить дублирующийся код мостов.

### Фаза 2: плагины с лёгкими прямыми импортами

- Мигрировать Matrix на SDK + runtime.
- Проверить онбординг, каталог и логику упоминаний в группах.

### Фаза 3: плагины с тяжёлыми прямыми импортами

- Мигрировать MS Teams (наибольший набор хелперов runtime).
- Убедиться, что семантика ответов/индикаторов набора текста соответствует текущему поведению.

### Фаза 4: плагинизация iMessage

- Переместить iMessage в `extensions/imessage`.
- Заменить прямые вызовы core на `api.runtime`.
- Сохранить ключи конфигурации, поведение CLI и документацию без изменений.

### Фаза 5: принудительное соблюдение

- Добавить правило линтера / проверку CI: никаких импортов `extensions/**` из `src/**`.
- Добавить проверки совместимости SDK/версий плагинов (runtime + semver SDK).

## Совместимость и версионирование

- SDK: semver, публикация, документированные изменения.
- Runtime: версионируется на релиз core. Добавить `api.runtime.version`.
- Плагины объявляют требуемый диапазон runtime (например, `openclawRuntime: ">=2026.2.0"`).

## Стратегия тестирования

- Юнит-тесты на уровне адаптеров (функции runtime выполняются с реальной реализацией core).
- Golden-тесты для каждого плагина: отсутствие дрейфа поведения (маршрутизация, сопряжение, список разрешённых, гейтинг упоминаний).
- Один сквозной пример плагина, используемый в CI (установка + запуск + smoke).

## Открытые вопросы

- Где размещать типы SDK: отдельный пакет или экспорт из core?
- Распространение типов runtime: в SDK (только типы) или в core?
- Как предоставлять ссылки на документацию для встроенных и внешних плагинов?
- Разрешаем ли ограниченные прямые импорты core для плагинов в репозитории на время перехода?

## Критерии успеха

- Все коннекторы каналов — это плагины, использующие SDK + runtime.
- Нет импортов `extensions/**` из `src/**`.
- Новые шаблоны коннекторов зависят только от SDK + runtime.
- Внешние плагины можно разрабатывать и обновлять без доступа к исходному коду core.

Связанная документация: [Plugins](/tools/plugin), [Channels](/channels/index), [Configuration](/gateway/configuration).
