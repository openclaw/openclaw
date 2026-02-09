---
summary: "OpenClaw на Raspberry Pi (бюджетная самохостинговая настройка)"
read_when:
  - Настройка OpenClaw на Raspberry Pi
  - Запуск OpenClaw на ARM-устройствах
  - Создание недорогого постоянно работающего персонального ИИ
title: "Raspberry Pi"
---

# OpenClaw на Raspberry Pi

## Цель

Запустить постоянный, всегда включённый Gateway (шлюз) OpenClaw на Raspberry Pi с **разовыми затратами ~35–80 $** (без ежемесячных платежей).

Идеально подходит для:

- персонального ИИ‑ассистента 24/7
- хаба домашней автоматизации
- энергоэффективного, всегда доступного бота Telegram/WhatsApp

## Требования к оборудованию

| Модель Pi       | RAM     | Работает?   | Примечания                                  |
| --------------- | ------- | ----------- | ------------------------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ Лучший    | Самый быстрый, рекомендуется                |
| **Pi 4**        | 4GB     | ✅ Хорошо    | Сладкая точка для большинства пользователей |
| **Pi 4**        | 2GB     | ✅ Норм      | Работает, добавьте swap                     |
| **Pi 4**        | 1GB     | ⚠️ Тесно    | Возможно со swap, минимальный конфиг        |
| **Pi 3B+**      | 1GB     | ⚠️ Медленно | Работает, но неторопливо                    |
| **Pi Zero 2 W** | 512MB   | ❌           | Не рекомендуется                            |

**Минимальные характеристики:** 1GB RAM, 1 ядро, 500MB диска  
**Рекомендуется:** 2GB+ RAM, 64‑битная ОС, SD‑карта 16GB+ (или USB SSD)

## Что понадобится

- Raspberry Pi 4 или 5 (рекомендуется 2GB+)
- MicroSD‑карта (16GB+) или USB SSD (лучшая производительность)
- Блок питания (рекомендуется официальный PSU Pi)
- Сетевое подключение (Ethernet или WiFi)
- ~30 минут

## 1. Прошивка ОС

Используйте **Raspberry Pi OS Lite (64-bit)** — рабочий стол не нужен для headless‑сервера.

1. Скачайте [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Выберите ОС: **Raspberry Pi OS Lite (64-bit)**
3. Нажмите на иконку шестерёнки (⚙️) для предварительной настройки:
   - Задайте hostname: `gateway-host`
   - Включите SSH
   - Установите имя пользователя/пароль
   - Настройте WiFi (если не используете Ethernet)
4. Запишите образ на SD‑карту / USB‑накопитель
5. Вставьте носитель и загрузите Pi

## 2) Подключение по SSH

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3. Настройка системы

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl build-essential

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

## 4. Установка Node.js 22 (ARM64)

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v22.x.x
npm --version
```

## 5. Добавление swap (важно для 2GB или меньше)

Swap предотвращает сбои из‑за нехватки памяти:

```bash
# Create 2GB swap file
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Optimize for low RAM (reduce swappiness)
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 6. Установка OpenClaw

### Вариант A: Стандартная установка (рекомендуется)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### Вариант B: Установка для модификаций (для экспериментов)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

Установка для модификаций даёт прямой доступ к логам и коду — полезно для отладки проблем, специфичных для ARM.

## 7. Запуск онбординга

```bash
openclaw onboard --install-daemon
```

Следуйте мастеру:

1. **Режим Gateway (шлюз):** Local
2. **Аутентификация:** рекомендуется API‑ключи (OAuth может быть нестабильным на headless Pi)
3. **Каналы:** проще всего начать с Telegram
4. **Демон:** Да (systemd)

## 8) Проверка установки

```bash
# Check status
openclaw status

# Check service
sudo systemctl status openclaw

# View logs
journalctl -u openclaw -f
```

## 9. Доступ к панели управления

Поскольку Pi работает без экрана, используйте SSH‑туннель:

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

Или используйте Tailscale для постоянного доступа:

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Update config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## Оптимизация производительности

### Используйте USB SSD (огромное улучшение)

SD‑карты медленные и изнашиваются. USB SSD значительно повышает производительность:

```bash
# Check if booting from USB
lsblk
```

См. [руководство по загрузке Pi с USB](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) для настройки.

### Снижение потребления памяти

```bash
# Disable GPU memory allocation (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Disable Bluetooth if not needed
sudo systemctl disable bluetooth
```

### Мониторинг ресурсов

```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Live monitoring
htop
```

---

## Примечания для ARM

### Совместимость бинарников

Большинство возможностей OpenClaw работает на ARM64, но для некоторых внешних бинарников могут потребоваться ARM‑сборки:

| Инструмент                            | Статус ARM64 | Примечания                          |
| ------------------------------------- | ------------ | ----------------------------------- |
| Node.js               | ✅            | Отлично работает                    |
| WhatsApp (Baileys) | ✅            | Чистый JS, без проблем              |
| Telegram                              | ✅            | Чистый JS, без проблем              |
| gog (Gmail CLI)    | ⚠️           | Проверьте наличие ARM‑релиза        |
| Chromium (браузер) | ✅            | `sudo apt install chromium-browser` |

Если skill не работает, проверьте, есть ли у его бинарника ARM‑сборка. У многих инструментов на Go/Rust она есть; у некоторых — нет.

### 32‑бит vs 64‑бит

**Всегда используйте 64‑битную ОС.** Node.js и многие современные инструменты требуют её. Проверьте командой:

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## Рекомендуемая настройка моделей

Поскольку Pi используется только как Gateway (шлюз) (модели работают в облаке), применяйте модели с доступом по API:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-20250514",
        "fallbacks": ["openai/gpt-4o-mini"]
      }
    }
  }
}
```

**Не пытайтесь запускать локальные LLM на Pi** — даже небольшие модели слишком медленные. Пусть Claude/GPT выполняют основную работу.

---

## Автозапуск при загрузке

Мастер онбординга настраивает это автоматически, но для проверки:

```bash
# Check service is enabled
sudo systemctl is-enabled openclaw

# Enable if not
sudo systemctl enable openclaw

# Start on boot
sudo systemctl start openclaw
```

---

## Устранение неполадок

### Нехватка памяти (OOM)

```bash
# Check memory
free -h

# Add more swap (see Step 5)
# Or reduce services running on the Pi
```

### Низкая производительность

- Используйте USB SSD вместо SD‑карты
- Отключите неиспользуемые сервисы: `sudo systemctl disable cups bluetooth avahi-daemon`
- Проверьте троттлинг CPU: `vcgencmd get_throttled` (должно вернуть `0x0`)

### Сервис не запускается

```bash
# Check logs
journalctl -u openclaw --no-pager -n 100

# Common fix: rebuild
cd ~/openclaw  # if using hackable install
npm run build
sudo systemctl restart openclaw
```

### Проблемы с ARM‑бинарниками

Если skill завершается с ошибкой «exec format error»:

1. Проверьте наличие ARM64‑сборки бинарника
2. Попробуйте собрать из исходников
3. Или используйте Docker‑контейнер с поддержкой ARM

### Обрывы WiFi

Для headless Pi, работающих по WiFi:

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## Сравнение стоимости

| Конфигурация                      | Разовые затраты      | Ежемесячно | Примечания                                             |
| --------------------------------- | -------------------- | ---------- | ------------------------------------------------------ |
| **Pi 4 (2GB)** | ~$45 | $0         | + питание (~$5/год) |
| **Pi 4 (4GB)** | ~$55 | $0         | Рекомендуется                                          |
| **Pi 5 (4GB)** | ~$60 | $0         | Лучшая производительность                              |
| **Pi 5 (8GB)** | ~$80 | $0         | Перебор, но будущее                                    |
| DigitalOcean                      | $0                   | $6/мес     | $72/год                                                |
| Hetzner                           | $0                   | €3,79/мес  | ~$50/год                               |

**Точка окупаемости:** Pi окупается примерно за 6–12 месяцев по сравнению с облачным VPS.

---

## См. также

- [Руководство по Linux](/platforms/linux) — общая настройка Linux
- [Руководство DigitalOcean](/platforms/digitalocean) — облачная альтернатива
- [Руководство Hetzner](/install/hetzner) — настройка Docker
- [Tailscale](/gateway/tailscale) — удалённый доступ
- [Nodes](/nodes) — сопряжение ноутбука/телефона с Pi‑шлюзом Gateway
