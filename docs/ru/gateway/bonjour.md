---
summary: "Обнаружение Bonjour/mDNS + отладка (маяки Gateway, клиенты и типичные сбои)"
read_when:
  - Отладка проблем обнаружения Bonjour на macOS/iOS
  - Изменение типов сервисов mDNS, TXT‑записей или UX обнаружения
title: "Обнаружение Bonjour"
---

# Обнаружение Bonjour / mDNS

OpenClaw использует Bonjour (mDNS / DNS‑SD) как **удобный механизм только для LAN**
для обнаружения активного Gateway (шлюз) (WebSocket‑эндпоинта). Это решение с
наилучшим усилием и **не** заменяет подключение по SSH или на базе Tailnet.

## Широкозонный Bonjour (Unicast DNS‑SD) поверх Tailscale

Если узел и Gateway (шлюз) находятся в разных сетях, мультикаст‑mDNS не пересекает
границу. Можно сохранить тот же UX обнаружения, переключившись на **unicast DNS‑SD**
(«Wide‑Area Bonjour») поверх Tailscale.

Высокоуровневые шаги:

1. Запустите DNS‑сервер на хосте шлюза Gateway (доступный по Tailnet).
2. Опубликуйте DNS‑SD‑записи для `_openclaw-gw._tcp` в выделенной зоне
   (пример: `openclaw.internal.`).
3. Настройте **split DNS** в Tailscale так, чтобы выбранный домен разрешался через этот
   DNS‑сервер для клиентов (включая iOS).

OpenClaw поддерживает любой домен обнаружения; `openclaw.internal.` приведён лишь как пример.
Узлы iOS/Android просматривают как `local.`, так и настроенный вами широкозонный домен.

### Конфиг Gateway (шлюз) (рекомендуется)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### Одноразовая настройка DNS‑сервера (хост шлюза Gateway)

```bash
openclaw dns setup --apply
```

Это устанавливает CoreDNS и настраивает его на:

- прослушивание порта 53 только на Tailscale‑интерфейсах шлюза Gateway
- обслуживание выбранного домена (пример: `openclaw.internal.`) из `~/.openclaw/dns/<domain>.db`

Проверьте с машины, подключённой к tailnet:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Настройки DNS в Tailscale

В консоли администратора Tailscale:

- Добавьте сервер имён, указывающий на tailnet‑IP шлюза Gateway (UDP/TCP 53).
- Добавьте split DNS, чтобы ваш домен обнаружения использовал этот сервер имён.

После того как клиенты примут DNS tailnet, узлы iOS смогут просматривать
`_openclaw-gw._tcp` в вашем домене обнаружения без мультикаста.

### Безопасность слушателя Gateway (шлюз) (рекомендуется)

WS‑порт Gateway (шлюз) (по умолчанию `18789`) по умолчанию привязывается к loopback. Для доступа по LAN/tailnet выполните явную привязку и оставьте аутентификацию включённой.

Для конфигураций только с tailnet:

- Установите `gateway.bind: "tailnet"` в `~/.openclaw/openclaw.json`.
- Перезапустите Gateway (шлюз) (или перезапустите приложение в строке меню macOS).

## Что реклама

Только Gateway (шлюз) объявляет `_openclaw-gw._tcp`.

## Типы сервисов

- `_openclaw-gw._tcp` — транспортный маяк шлюза Gateway (используется узлами macOS/iOS/Android).

## TXT‑ключи (не секретные подсказки)

Gateway (шлюз) объявляет небольшие не секретные подсказки для удобства UI‑потоков:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (только при включённом TLS)
- `gatewayTlsSha256=<sha256>` (только при включённом TLS и доступном отпечатке)
- `canvasPort=<port>` (только когда включён хост canvas; по умолчанию `18793`)
- `sshPort=<port>` (по умолчанию 22, если не переопределён)
- `transport=gateway`
- `cliPath=<path>` (необязательно; абсолютный путь к исполняемому `openclaw` entrypoint)
- `tailnetDns=<magicdns>` (необязательная подсказка, когда доступен Tailnet)

## Отладка на macOS

Полезные встроенные инструменты:

- Просмотр экземпляров:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- Разрешение одного экземпляра (замените `<instance>`):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

Если просмотр работает, но разрешение не удаётся, обычно это связано с политикой LAN
или проблемой резолвера mDNS.

## Отладка в логах Gateway (шлюз)

Gateway (шлюз) пишет циклический лог‑файл (путь выводится при запуске как
`gateway log file: ...`). Ищите строки `bonjour:`, в частности:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## Отладка на узле iOS

Узел iOS использует `NWBrowser` для обнаружения `_openclaw-gw._tcp`.

Чтобы собрать логи:

- Settings → Gateway → Advanced → **Discovery Debug Logs**
- Settings → Gateway → Advanced → **Discovery Logs** → воспроизвести → **Copy**

Лог включает переходы состояний браузера и изменения набора результатов.

## Типичные сбои

- **Bonjour не пересекает сети**: используйте Tailnet или SSH.
- **Мультикаст заблокирован**: некоторые Wi‑Fi‑сети отключают mDNS.
- **Сон / смена интерфейсов**: macOS может временно терять результаты mDNS; повторите попытку.
- **Просмотр работает, но разрешение не удаётся**: используйте простые имена машин (избегайте эмодзи или
  знаков пунктуации), затем перезапустите Gateway (шлюз). Имя экземпляра сервиса
  производно от имени хоста, поэтому слишком сложные имена могут путать некоторые резолверы.

## Экранированные имена экземпляров (`\032`)

Bonjour/DNS‑SD часто экранирует байты в именах экземпляров сервисов в виде десятичных
последовательностей `\DDD` (например, пробелы становятся `\032`).

- Это нормально на уровне протокола.
- UI должны декодировать для отображения (iOS использует `BonjourEscapes.decode`).

## Отключение / конфигурация

- `OPENCLAW_DISABLE_BONJOUR=1` отключает объявление (legacy: `OPENCLAW_DISABLE_BONJOUR`).
- `gateway.bind` в `~/.openclaw/openclaw.json` управляет режимом привязки Gateway (шлюз).
- `OPENCLAW_SSH_PORT` переопределяет SSH‑порт, объявляемый в TXT (legacy: `OPENCLAW_SSH_PORT`).
- `OPENCLAW_TAILNET_DNS` публикует подсказку MagicDNS в TXT (legacy: `OPENCLAW_TAILNET_DNS`).
- `OPENCLAW_CLI_PATH` переопределяет объявляемый путь CLI (legacy: `OPENCLAW_CLI_PATH`).

## Связанная документация

- Политика обнаружения и выбор транспорта: [Discovery](/gateway/discovery)
- Сопряжение узлов + подтверждения: [Gateway pairing](/gateway/pairing)
