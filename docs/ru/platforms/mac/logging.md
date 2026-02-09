---
summary: "Логирование OpenClaw: диагностический файл с ротацией + флаги приватности unified logging"
read_when:
  - Захват логов macOS или расследование логирования приватных данных
  - Отладка проблем жизненного цикла голосового пробуждения/сеанса
title: "Логирование в macOS"
---

# Логирование (macOS)

## Диагностический файл лога с ротацией (панель Debug)

OpenClaw направляет логи приложения macOS через swift-log (по умолчанию — unified logging) и при необходимости может записывать локальный файл лога с ротацией на диск для долговременного захвата.

- Уровень детализации: **Debug pane → Logs → App logging → Verbosity**
- Включить: **Debug pane → Logs → App logging → «Write rolling diagnostics log (JSONL)»**
- Расположение: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (ротация выполняется автоматически; старые файлы получают суффиксы `.1`, `.2`, …)
- Очистить: **Debug pane → Logs → App logging → «Clear»**

Примечания:

- По умолчанию **выключено**. Включайте только на время активной отладки.
- Считайте файл чувствительным; не делитесь им без проверки.

## Приватные данные unified logging в macOS

Unified logging скрывает большинство полезной нагрузки, если подсистема явно не включает `privacy -off`. Согласно материалу Питера о macOS [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025), это управляется plist-файлом в `/Library/Preferences/Logging/Subsystems/`, ключируемым по имени подсистемы. Флаг применяется только к новым записям логов, поэтому включайте его до воспроизведения проблемы.

## Включение для OpenClaw (`bot.molt`)

- Сначала запишите plist во временный файл, затем установите его атомарно от имени root:

```bash
cat <<'EOF' >/tmp/bot.molt.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>DEFAULT-OPTIONS</key>
    <dict>
        <key>Enable-Private-Data</key>
        <true/>
    </dict>
</dict>
</plist>
EOF
sudo install -m 644 -o root -g wheel /tmp/bot.molt.plist /Library/Preferences/Logging/Subsystems/bot.molt.plist
```

- Перезагрузка не требуется; logd быстро обнаруживает файл, однако только новые строки логов будут содержать приватную полезную нагрузку.
- Просматривайте более подробный вывод с помощью существующего хелпера, например `./scripts/clawlog.sh --category WebChat --last 5m`.

## Отключение после отладки

- Удалите переопределение: `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`.
- При необходимости выполните `sudo log config --reload`, чтобы принудительно заставить logd немедленно сбросить переопределение.
- Помните, что этот механизм может включать номера телефонов и тела сообщений; держите plist на месте только пока вам действительно нужна дополнительная детализация.
