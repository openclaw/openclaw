---
summary: "Интегрированная служба управления браузером + команды действий"
read_when:
  - Добавление автоматизации браузера под управлением агента
  - Отладка причин, по которым openclaw вмешивается в работу вашего Chrome
  - Реализация настроек браузера и жизненного цикла в приложении для macOS
title: "Браузер (под управлением OpenClaw)"
---

# Браузер (под управлением openclaw)

OpenClaw может запускать **выделенный профиль Chrome/Brave/Edge/Chromium**, которым управляет агент.
Он изолирован от вашего личного браузера и управляется через небольшую локальную
службу управления внутри Gateway (шлюз) (только local loopback).

Взгляд для начинающих:

- Думайте об этом как об **отдельном браузере только для агента**.
- Профиль `openclaw` **не** затрагивает ваш личный профиль браузера.
- Агент может **открывать вкладки, читать страницы, кликать и печатать** в безопасной среде.
- Профиль `chrome` по умолчанию использует **системный Chromium-браузер по умолчанию** через
  релей расширения; переключитесь на `openclaw` для изолированного управляемого браузера.

## Что вы получаете

- Отдельный профиль браузера с именем **openclaw** (по умолчанию с оранжевым акцентом).
- Детерминированное управление вкладками (список/открыть/фокус/закрыть).
- Действия агента (клик/ввод/перетаскивание/выбор), снимки, скриншоты, PDF.
- Необязательная поддержка нескольких профилей (`openclaw`, `work`, `remote`, ...).

Этот браузер **не** предназначен для повседневного использования. Это безопасная,
изолированная поверхность для автоматизации и верификации агентом.

## Быстрый старт

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

Если вы видите «Browser disabled», включите его в конфигурации (см. ниже) и
перезапустите Gateway (шлюз).

## Профили: `openclaw` vs `chrome`

- `openclaw`: управляемый, изолированный браузер (расширение не требуется).
- `chrome`: релей расширения к вашему **системному браузеру** (требуется подключение расширения OpenClaw к вкладке).

Установите `browser.defaultProfile: "openclaw"`, если хотите использовать управляемый режим по умолчанию.

## Конфигурация

Настройки браузера находятся в `~/.openclaw/openclaw.json`.

```json5
{
  browser: {
    enabled: true, // default: true
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    remoteCdpTimeoutMs: 1500, // remote CDP HTTP timeout (ms)
    remoteCdpHandshakeTimeoutMs: 3000, // remote CDP WebSocket handshake timeout (ms)
    defaultProfile: "chrome",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
  },
}
```

Примечания:

- Служба управления браузером привязывается к local loopback на порту, производном от `gateway.port`
  (по умолчанию: `18791`, то есть порт Gateway + 2). Релей использует следующий порт (`18792`).
- Если вы переопределяете порт Gateway (`gateway.port` или `OPENCLAW_GATEWAY_PORT`),
  производные порты браузера сдвигаются, чтобы оставаться в том же «семействе».
- `cdpUrl` по умолчанию равен порту релея, если не задан.
- `remoteCdpTimeoutMs` применяется к проверкам доступности удалённого CDP (не local loopback).
- `remoteCdpHandshakeTimeoutMs` применяется к проверкам доступности WebSocket удалённого CDP.
- `attachOnly: true` означает «никогда не запускать локальный браузер; подключаться только если он уже запущен».
- `color` + профильное `color` подкрашивают UI браузера, чтобы было видно, какой профиль активен.
- Профиль по умолчанию — `chrome` (релей расширения). Используйте `defaultProfile: "openclaw"` для управляемого браузера.
- Порядок автоопределения: системный браузер по умолчанию, если он на базе Chromium; иначе Chrome → Brave → Edge → Chromium → Chrome Canary.
- Локальные профили `openclaw` автоматически назначают `cdpPort`/`cdpUrl` — задавайте их только для удалённого CDP.

## Использование Brave (или другого браузера на базе Chromium)

Если ваш **системный браузер по умолчанию** основан на Chromium (Chrome/Brave/Edge и т. д.),
OpenClaw использует его автоматически. Установите `browser.executablePath`, чтобы переопределить
автоопределение:

Пример CLI:

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
```

```json5
// macOS
{
  browser: {
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  }
}

// Windows
{
  browser: {
    executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  }
}

// Linux
{
  browser: {
    executablePath: "/usr/bin/brave-browser"
  }
}
```

## Локальное и удаленное управление

- **Локальное управление (по умолчанию):** Gateway (шлюз) запускает службу управления на loopback и может запускать локальный браузер.
- **Удалённое управление (хост узла):** запустите хост узла на машине с браузером; Gateway проксирует к нему действия браузера.
- **Удалённый CDP:** задайте `browser.profiles.<name>.cdpUrl` (или `browser.cdpUrl`), чтобы
  подключиться к удалённому браузеру на базе Chromium. В этом случае OpenClaw не будет запускать локальный браузер.

URL удалённого CDP могут включать аутентификацию:

- Токены в query (например, `https://provider.example?token=<token>`)
- HTTP Basic auth (например, `https://user:pass@provider.example`)

OpenClaw сохраняет аутентификацию при вызове эндпоинтов `/json/*` и при подключении
к WebSocket CDP. Предпочитайте переменные окружения или менеджеры секретов
для токенов вместо их коммита в конфигурационные файлы.

## Прокси браузера узла (zero-config по умолчанию)

Если вы запускаете **хост узла** на машине с браузером, OpenClaw может
автоматически маршрутизировать вызовы инструментов браузера к этому узлу без дополнительной конфигурации браузера.
Это путь по умолчанию для удалённых Gateway.

Примечания:

- Хост узла экспортирует свою локальную службу управления браузером через **прокси-команду**.
- Профили берутся из собственного конфига узла `browser.profiles` (как и локально).
- Отключите, если это не нужно:
  - На узле: `nodeHost.browserProxy.enabled=false`
  - На Gateway: `gateway.nodes.browser.mode="off"`

## Browserless (хостинг удалённого CDP)

[Browserless](https://browserless.io) — это хостинг Chromium, предоставляющий
эндпоинты CDP по HTTPS. Вы можете указать для профиля браузера OpenClaw
региональный эндпоинт Browserless и аутентифицироваться с помощью ключа API.

Пример:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserless",
    remoteCdpTimeoutMs: 2000,
    remoteCdpHandshakeTimeoutMs: 4000,
    profiles: {
      browserless: {
        cdpUrl: "https://production-sfo.browserless.io?token=<BROWSERLESS_API_KEY>",
        color: "#00AA00",
      },
    },
  },
}
```

Примечания:

- Замените `<BROWSERLESS_API_KEY>` на ваш реальный токен Browserless.
- Выберите региональный эндпоинт, соответствующий вашей учётной записи Browserless (см. их документацию).

## Безопасность

Ключевые идеи:

- Управление браузером доступно только через loopback; доступ проходит через аутентификацию Gateway или сопряжение узла.
- Держите Gateway и любые хосты узлов в приватной сети (Tailscale); избегайте публичного доступа.
- Рассматривайте URL/токены удалённого CDP как секреты; предпочитайте переменные окружения или менеджер секретов.

Советы по удалённому CDP:

- По возможности используйте HTTPS-эндпоинты и краткоживущие токены.
- Избегайте встраивания долгоживущих токенов напрямую в конфигурационные файлы.

## Профили (мультибраузер)

OpenClaw поддерживает несколько именованных профилей (конфигурации маршрутизации). Профили могут быть:

- **openclaw-managed**: выделенный экземпляр браузера на базе Chromium с собственной директорией пользовательских данных и портом CDP
- **remote**: явный URL CDP (браузер на базе Chromium, запущенный в другом месте)
- **extension relay**: ваши существующие вкладки Chrome через локальный релей + расширение Chrome

Значения по умолчанию:

- Профиль `openclaw` создаётся автоматически, если отсутствует.
- Профиль `chrome` встроен для релея расширения Chrome (по умолчанию указывает на `http://127.0.0.1:18792`).
- Локальные порты CDP по умолчанию выделяются из диапазона **18800–18899**.
- Удаление профиля перемещает его локальную директорию данных в Корзину.

Все эндпоинты управления принимают `?profile=<name>`; CLI использует `--browser-profile`.

## Релей расширения Chrome (используйте существующий Chrome)

OpenClaw также может управлять **вашими существующими вкладками Chrome**
(без отдельного экземпляра Chrome «openclaw») через локальный CDP-релей и расширение Chrome.

Полное руководство: [Chrome extension](/tools/chrome-extension)

Поток:

- Gateway запускается локально (на той же машине), либо хост узла запускается на машине с браузером.
- Локальный **сервер-релей** слушает на loopback `cdpUrl` (по умолчанию: `http://127.0.0.1:18792`).
- Вы нажимаете на иконку расширения **OpenClaw Browser Relay** на вкладке, чтобы подключиться (автоподключения нет).
- Агент управляет этой вкладкой через обычный инструмент `browser`, выбрав правильный профиль.

Если Gateway запущен в другом месте, запустите хост узла на машине с браузером, чтобы Gateway мог проксировать действия браузера.

### Сеансы в sandbox

Если сеанс агента находится в sandbox, инструмент `browser` может по умолчанию использовать `target="sandbox"` (sandbox browser).
Перехват управления через релей расширения Chrome требует управления браузером хоста, поэтому либо:

- запускайте сеанс без sandbox, либо
- установите `agents.defaults.sandbox.browser.allowHostControl: true` и используйте `target="host"` при вызове инструмента.

### Настройка

1. Загрузите расширение (dev/unpacked):

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → включите «Developer mode»
- «Load unpacked» → выберите каталог, выведенный `openclaw browser extension path`
- Закрепите расширение, затем нажмите его на вкладке, которой хотите управлять (значок показывает `ON`).

2. Использование:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Инструмент агента: `browser` с `profile="chrome"`

Необязательно: если вы хотите другое имя или порт релея, создайте собственный профиль:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

Примечания:

- Этот режим опирается на Playwright-on-CDP для большинства операций (скриншоты/снимки/действия).
- Отключение — нажмите на иконку расширения ещё раз.

## Гарантии изоляции

- **Выделенная директория пользовательских данных**: никогда не затрагивает ваш личный профиль браузера.
- **Выделенные порты**: избегает `9222`, предотвращая коллизии с рабочими процессами разработки.
- **Детерминированное управление вкладками**: нацеливание по `targetId`, а не по «последней вкладке».

## Выбор браузера

При локальном запуске OpenClaw выбирает первый доступный:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

Вы можете переопределить выбор с помощью `browser.executablePath`.

Платформы:

- macOS: проверяет `/Applications` и `~/Applications`.
- Linux: ищет `google-chrome`, `brave`, `microsoft-edge`, `chromium` и т. д.
- Windows: проверяет стандартные каталоги установки.

## API управления (необязательно)

Только для локальных интеграций Gateway предоставляет небольшой HTTP API на loopback:

- Статус/запуск/остановка: `GET /`, `POST /start`, `POST /stop`
- Вкладки: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- Снимок/скриншот: `GET /snapshot`, `POST /screenshot`
- Действия: `POST /navigate`, `POST /act`
- Хуки: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- Загрузки: `POST /download`, `POST /wait/download`
- Отладка: `GET /console`, `POST /pdf`
- Отладка: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- Сеть: `POST /response/body`
- Состояние: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- Состояние: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- Настройки: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

Все эндпоинты принимают `?profile=<name>`.

### Требование Playwright

Некоторые возможности (navigate/act/AI snapshot/role snapshot, скриншоты элементов, PDF) требуют
Playwright. Если Playwright не установлен, эти эндпоинты возвращают понятную ошибку 501. ARIA-снимки и базовые скриншоты продолжают работать для openclaw-managed Chrome.
Для драйвера релея расширения Chrome ARIA-снимки и скриншоты требуют Playwright.

Если вы видите `Playwright is not available in this gateway build`, установите полный пакет
Playwright (не `playwright-core`) и перезапустите Gateway, либо переустановите
OpenClaw с поддержкой браузера.

#### Установка Playwright в Docker

Если ваш Gateway работает в Docker, избегайте `npx playwright` (конфликты override npm).
Используйте встроенный CLI:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Чтобы сохранять загрузки браузера, задайте `PLAYWRIGHT_BROWSERS_PATH` (например,
`/home/node/.cache/ms-playwright`) и убедитесь, что `/home/node` сохраняется через
`OPENCLAW_HOME_VOLUME` или bind mount. См. [Docker](/install/docker).

## Как это работает (внутренне)

Высокоуровневый поток:

- Небольшой **сервер управления** принимает HTTP-запросы.
- Он подключается к браузерам на базе Chromium (Chrome/Brave/Edge/Chromium) через **CDP**.
- Для продвинутых действий (клик/ввод/снимок/PDF) используется **Playwright** поверх CDP.
- При отсутствии Playwright доступны только операции без Playwright.

Этот дизайн сохраняет для агента стабильный, детерминированный интерфейс, позволяя
менять локальные/удалённые браузеры и профили.

## Краткий справочник CLI

Все команды принимают `--browser-profile <name>` для указания конкретного профиля.
Все команды также принимают `--json` для машиночитаемого вывода (стабильные payload).

Базовые:

- `openclaw browser status`
- `openclaw browser start`
- `openclaw browser stop`
- `openclaw browser tabs`
- `openclaw browser tab`
- `openclaw browser tab new`
- `openclaw browser tab select 2`
- `openclaw browser tab close 2`
- `openclaw browser open https://example.com`
- `openclaw browser focus abcd1234`
- `openclaw browser close abcd1234`

Инспекция:

- `openclaw browser screenshot`
- `openclaw browser screenshot --full-page`
- `openclaw browser screenshot --ref 12`
- `openclaw browser screenshot --ref e12`
- `openclaw browser snapshot`
- `openclaw browser snapshot --format aria --limit 200`
- `openclaw browser snapshot --interactive --compact --depth 6`
- `openclaw browser snapshot --efficient`
- `openclaw browser snapshot --labels`
- `openclaw browser snapshot --selector "#main" --interactive`
- `openclaw browser snapshot --frame "iframe#main" --interactive`
- `openclaw browser console --level error`
- `openclaw browser errors --clear`
- `openclaw browser requests --filter api --clear`
- `openclaw browser pdf`
- `openclaw browser responsebody "**/api" --max-chars 5000`

Действия:

- `openclaw browser navigate https://example.com`
- `openclaw browser resize 1280 720`
- `openclaw browser click 12 --double`
- `openclaw browser click e12 --double`
- `openclaw browser type 23 "hello" --submit`
- `openclaw browser press Enter`
- `openclaw browser hover 44`
- `openclaw browser scrollintoview e12`
- `openclaw browser drag 10 11`
- `openclaw browser select 9 OptionA OptionB`
- `openclaw browser download e12 /tmp/report.pdf`
- `openclaw browser waitfordownload /tmp/report.pdf`
- `openclaw browser upload /tmp/file.pdf`
- `openclaw browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'`
- `openclaw browser dialog --accept`
- `openclaw browser wait --text "Done"`
- `openclaw browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"`
- `openclaw browser evaluate --fn '(el) => el.textContent' --ref 7`
- `openclaw browser highlight e12`
- `openclaw browser trace start`
- `openclaw browser trace stop`

Состояние:

- `openclaw browser cookies`
- `openclaw browser cookies set session abc123 --url "https://example.com"`
- `openclaw browser cookies clear`
- `openclaw browser storage local get`
- `openclaw browser storage local set theme dark`
- `openclaw browser storage session clear`
- `openclaw browser set offline on`
- `openclaw browser set headers --json '{"X-Debug":"1"}'`
- `openclaw browser set credentials user pass`
- `openclaw browser set credentials --clear`
- `openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"`
- `openclaw browser set geo --clear`
- `openclaw browser set media dark`
- `openclaw browser set timezone America/New_York`
- `openclaw browser set locale en-US`
- `openclaw browser set device "iPhone 14"`

Примечания:

- `upload` и `dialog` — это вызовы **arming**; выполните их перед кликом/нажатием,
  которое запускает выбор/диалог.
- `upload` также может напрямую задавать file input через `--input-ref` или `--element`.
- `snapshot`:
  - `--format ai` (по умолчанию, когда установлен Playwright): возвращает AI-снимок с числовыми ссылками (`aria-ref="<n>"`).
  - `--format aria`: возвращает дерево доступности (без ссылок; только для инспекции).
  - `--efficient` (или `--mode efficient`): компактный пресет role snapshot (интерактивный + компактный + глубина + уменьшенный maxChars).
  - Значение по умолчанию конфига (только tool/CLI): установите `browser.snapshotDefaults.mode: "efficient"`, чтобы использовать эффективные снимки, когда вызывающая сторона не передаёт режим (см. [Конфигурация Gateway](/gateway/configuration#browser-openclaw-managed-browser)).
  - Параметры role snapshot (`--interactive`, `--compact`, `--depth`, `--selector`) принудительно создают role-based снимок со ссылками вида `ref=e12`.
  - `--frame "<iframe selector>"` ограничивает role snapshot iframe (в паре с role refs вида `e12`).
  - `--interactive` выводит плоский, удобный для выбора список интерактивных элементов (лучше всего для управления действиями).
  - `--labels` добавляет скриншот только области видимости с наложенными метками ссылок (печатает `MEDIA:<path>`).
- `click`/`type`/и т. д. требуют `ref` из `snapshot` (числовой `12` или role ref `e12`).
  CSS-селекторы намеренно не поддерживаются для действий.

## Снимки и рефералы

OpenClaw поддерживает два стиля «снимков»:

- **AI snapshot (числовые ссылки)**: `openclaw browser snapshot` (по умолчанию; `--format ai`)
  - Вывод: текстовый снимок, включающий числовые ссылки.
  - Действия: `openclaw browser click 12`, `openclaw browser type 23 "hello"`.
  - Внутренне ссылка разрешается через `aria-ref` Playwright.

- **Role snapshot (role refs вида `e12`)**: `openclaw browser snapshot --interactive` (или `--compact`, `--depth`, `--selector`, `--frame`)
  - Вывод: список/дерево на основе ролей с `[ref=e12]` (и необязательным `[nth=1]`).
  - Действия: `openclaw browser click e12`, `openclaw browser highlight e12`.
  - Внутренне ссылка разрешается через `getByRole(...)` (плюс `nth()` для дубликатов).
  - Добавьте `--labels`, чтобы включить скриншот области видимости с наложенными метками `e12`.

Базовое поведение:

- Ссылки **не стабильны между навигациями**; если что-то не сработало, повторно выполните `snapshot` и используйте свежую ссылку.
- Если role snapshot был сделан с `--frame`, role refs ограничены этим iframe до следующего role snapshot.

## Подождите

Можно ждать не только по времени/тексту:

- Ожидание URL (глоб-паттерны Playwright):
  - `openclaw browser wait --url "**/dash"`
- Ожидание состояния загрузки:
  - `openclaw browser wait --load networkidle`
- Ожидание JS-предиката:
  - `openclaw browser wait --fn "window.ready===true"`
- Ожидание видимости селектора:
  - `openclaw browser wait "#main"`

Их можно комбинировать:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## Отладка рабочих процессов

Когда действие не удаётся (например, «not visible», «strict mode violation», «covered»):

1. `openclaw browser snapshot --interactive`
2. Используйте `click <ref>` / `type <ref>` (предпочитайте role refs в интерактивном режиме)
3. Если всё ещё не работает: `openclaw browser highlight <ref>`, чтобы увидеть, на что нацеливается Playwright
4. Если страница ведёт себя странно:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. Для глубокой отладки: запишите трассу:
   - `openclaw browser trace start`
   - воспроизведите проблему
   - `openclaw browser trace stop` (печатает `TRACE:<path>`)

## Вывод в формате JSON

`--json` предназначен для скриптинга и структурированных инструментов.

Примеры:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

Role snapshot в JSON включает `refs` плюс небольшой блок `stats` (строки/символы/ссылки/интерактивность), чтобы инструменты могли оценивать размер и плотность payload.

## Ручки состояния и окружения

Полезны для сценариев «заставить сайт вести себя как X»:

- Cookies: `cookies`, `cookies set`, `cookies clear`
- Storage: `storage local|session get|set|clear`
- Offline: `set offline on|off`
- Заголовки: `set headers --json '{"X-Debug":"1"}'` (или `--clear`)
- HTTP basic auth: `set credentials user pass` (или `--clear`)
- Геолокация: `set geo <lat> <lon> --origin "https://example.com"` (или `--clear`)
- Медиа: `set media dark|light|no-preference|none`
- Часовой пояс / локаль: `set timezone ...`, `set locale ...`
- Устройство / viewport:
  - `set device "iPhone 14"` (пресеты устройств Playwright)
  - `set viewport 1280 720`

## Безопасность и конфиденциальность

- Профиль браузера openclaw может содержать авторизованные сессии; рассматривайте его как чувствительный.
- `browser act kind=evaluate` / `openclaw browser evaluate` и `wait --fn`
  выполняют произвольный JavaScript в контексте страницы. Prompt injection может этим управлять. Отключите это с помощью `browser.evaluateEnabled=false`, если вам это не нужно.
- Для входа и анти-бот примечаний (X/Twitter и т. д.) см. [Browser login + X/Twitter posting](/tools/browser-login).
- Держите Gateway/хост узла приватными (loopback или только tailnet).
- Эндпоинты удалённого CDP обладают большой мощью; туннелируйте и защищайте их.

## Устранение неполадок

Для проблем, специфичных для Linux (особенно snap Chromium), см. [Browser troubleshooting](/tools/browser-linux-troubleshooting).

## Инструменты агента и принцип управления

Агент получает **один инструмент** для автоматизации браузера:

- `browser` — статус/запуск/остановка/вкладки/открыть/фокус/закрыть/снимок/скриншот/навигация/действие

Как это сопоставляется:

- `browser snapshot` возвращает стабильное дерево UI (AI или ARIA).
- `browser act` использует идентификаторы `ref` снимка для клика/ввода/перетаскивания/выбора.
- `browser screenshot` захватывает пиксели (вся страница или элемент).
- `browser` принимает:
  - `profile` для выбора именованного профиля браузера (openclaw, chrome или удалённый CDP).
  - `target` (`sandbox` | `host` | `node`) для выбора расположения браузера.
  - В sandbox-сеансах `target: "host"` требует `agents.defaults.sandbox.browser.allowHostControl=true`.
  - Если `target` не указан: sandbox-сеансы по умолчанию используют `sandbox`, несandbox-сеансы — `host`.
  - Если подключён узел с поддержкой браузера, инструмент может автоматически маршрутизироваться к нему, если вы не закрепили `target="host"` или `target="node"`.

Это делает агента детерминированным и позволяет избегать хрупких селекторов.
