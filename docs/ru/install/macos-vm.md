---
summary: "Запуск OpenClaw в изолированной macOS VM (локальной или размещённой), когда требуется изоляция или iMessage"
read_when:
  - Вам нужен OpenClaw, изолированный от основной среды macOS
  - Вам нужна интеграция iMessage (BlueBubbles) в sandbox
  - Вам нужна сбрасываемая среда macOS, которую можно клонировать
  - Вы хотите сравнить локальные и размещённые варианты macOS VM
title: "macOS VM"
---

# OpenClaw на macOS VM (Sandboxing)

## Рекомендуемый вариант по умолчанию (для большинства пользователей)

- **Небольшой Linux VPS** для постоянно работающего Gateway (шлюз) и низкой стоимости. См. См. [VPS hosting](/vps).
- **Выделенное оборудование** (Mac mini или Linux‑сервер), если вам нужен полный контроль и **резидентный IP** для браузерной автоматизации. Многие сайты блокируют IP дата‑центров, поэтому локальный браузинг часто работает лучше.
- **Гибрид:** держите Gateway (шлюз) на дешёвом VPS и подключайте свой Mac как **узел**, когда нужна автоматизация браузера/UI. См. [Nodes](/nodes) и [Gateway remote](/gateway/remote).

Используйте macOS VM, когда вам нужны именно возможности macOS (iMessage/BlueBubbles) или требуется строгая изоляция от повседневного Mac.

## Варианты macOS VM

### Локальная VM на Apple Silicon Mac (Lume)

Запускайте OpenClaw в изолированной macOS VM на существующем Apple Silicon Mac с помощью [Lume](https://cua.ai/docs/lume).

Это даёт:

- Полноценную среду macOS в изоляции (хост остаётся «чистым»)
- Поддержку iMessage через BlueBubbles (невозможно на Linux/Windows)
- Мгновенный сброс за счёт клонирования VM
- Отсутствие дополнительных затрат на железо или облако

### Размещённые Mac‑провайдеры (облако)

Если вам нужна macOS в облаке, подойдут размещённые Mac‑провайдеры:

- [MacStadium](https://www.macstadium.com/) (размещённые Mac)
- Подойдут и другие провайдеры размещённых Mac; следуйте их документации по VM + SSH

После получения SSH‑доступа к macOS VM переходите к шагу 6 ниже.

---

## Быстрый путь (Lume, опытные пользователи)

1. Установите Lume
2. `lume create openclaw --os macos --ipsw latest`
3. Завершите Setup Assistant, включите Remote Login (SSH)
4. `lume run openclaw --no-display`
5. Подключитесь по SSH, установите OpenClaw, настройте каналы
6. Готово

---

## Что потребуется (Lume)

- Apple Silicon Mac (M1/M2/M3/M4)
- macOS Sequoia или новее на хосте
- ~60 ГБ свободного дискового пространства на VM
- ~20 минут

---

## 1. Установка Lume

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

Если `~/.local/bin` нет в PATH:

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

Проверка:

```bash
lume --version
```

Документация: [Lume Installation](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2. Создание macOS VM

```bash
lume create openclaw --os macos --ipsw latest
```

Команда загрузит macOS и создаст VM. Окно VNC откроется автоматически.

Примечание: загрузка может занять некоторое время в зависимости от вашего соединения.

---

## 3. Завершение Setup Assistant

В окне VNC:

1. Выберите язык и регион
2. Пропустите Apple ID (или войдите, если позже хотите iMessage)
3. Создайте учётную запись пользователя (запомните имя и пароль)
4. Пропустите все необязательные функции

После завершения настройки включите SSH:

1. Откройте System Settings → General → Sharing
2. Включите «Remote Login»

---

## 4. Получение IP‑адреса VM

```bash
lume get openclaw
```

Найдите IP‑адрес (обычно `192.168.64.x`).

---

## 5. Подключение по SSH к VM

```bash
ssh youruser@192.168.64.X
```

Замените `youruser` на созданную вами учётную запись, а IP — на IP вашей VM.

---

## 6. Установка OpenClaw

Внутри VM:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

Следуйте подсказкам онбординга для настройки провайдера модели (Anthropic, OpenAI и т. д.).

---

## 7. Настройка каналов

Отредактируйте файл конфига:

```bash
nano ~/.openclaw/openclaw.json
```

Добавьте свои каналы:

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    },
    "telegram": {
      "botToken": "YOUR_BOT_TOKEN"
    }
  }
}
```

Затем войдите в WhatsApp (отсканируйте QR‑код):

```bash
openclaw channels login
```

---

## 8. Запуск VM без графического интерфейса

Остановите VM и перезапустите без дисплея:

```bash
lume stop openclaw
lume run openclaw --no-display
```

VM будет работать в фоне. Демон OpenClaw поддерживает работу Gateway (шлюз).

Проверка статуса:

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## Бонус: интеграция iMessage

Это ключевая причина запуска на macOS. Используйте [BlueBubbles](https://bluebubbles.app), чтобы добавить iMessage в OpenClaw.

Внутри VM:

1. Загрузите BlueBubbles с bluebubbles.app
2. Войдите с помощью Apple ID
3. Включите Web API и задайте пароль
4. Укажите вебхуки BlueBubbles на ваш Gateway (шлюз) (пример: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

Добавьте в конфиг OpenClaw:

```json
{
  "channels": {
    "bluebubbles": {
      "serverUrl": "http://localhost:1234",
      "password": "your-api-password",
      "webhookPath": "/bluebubbles-webhook"
    }
  }
}
```

Перезапустите Gateway (шлюз). Теперь ваш агент может отправлять и получать iMessage.

Подробности настройки: [BlueBubbles channel](/channels/bluebubbles)

---

## Сохранение «золотого» образа

Перед дальнейшей кастомизацией снимите снапшот чистого состояния:

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

Сброс в любой момент:

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## Работа 24/7

Чтобы VM работала постоянно:

- Держите Mac подключённым к питанию
- Отключите сон в System Settings → Energy Saver
- При необходимости используйте `caffeinate`

Для истинных всегда рассмотрите специализированный Mac mini или небольшой VPS. См. [VPS hosting](/vps).

---

## Устранение неполадок

| Проблема                       | Решение                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Не удаётся подключиться по SSH | Проверьте, что «Remote Login» включён в System Settings VM                                                   |
| IP VM не отображается          | Дождитесь полной загрузки VM и снова выполните `lume get openclaw`                                           |
| Команда Lume не найдена        | Добавьте `~/.local/bin` в PATH                                                                               |
| QR WhatsApp не сканируется     | Убедитесь, что вы вошли именно в VM (а не на хосте) при запуске `openclaw channels login` |

---

## Связанная документация

- [VPS hosting](/vps)
- [Nodes](/nodes)
- [Gateway remote](/gateway/remote)
- [BlueBubbles channel](/channels/bluebubbles)
- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (для продвинутых)
- [Docker Sandboxing](/install/docker) (альтернативный подход к изоляции)
