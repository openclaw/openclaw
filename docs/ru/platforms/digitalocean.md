---
summary: "OpenClaw на DigitalOcean (простой платный вариант VPS)"
read_when:
  - Настройка OpenClaw на DigitalOcean
  - Поиск дешёвого VPS-хостинга для OpenClaw
title: "DigitalOcean"
---

# OpenClaw на DigitalOcean

## Цель

Запустить постоянный Gateway (шлюз) OpenClaw на DigitalOcean за **$6/месяц** (или $4/мес. при резервированном тарифе).

Если вам нужен вариант за $0/месяц и вы не против ARM и специфичной для провайдера настройки, см. [руководство по Oracle Cloud](/platforms/oracle).

## Сравнение стоимости (2026)

| Провайдер    | План            | Характеристики      | Цена/мес.                                      | Примечания                                         |
| ------------ | --------------- | ------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| Oracle Cloud | Always Free ARM | до 4 OCPU, 24GB RAM | $0                                                             | ARM, ограниченная доступность / нюансы регистрации |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM     | €3.79 (~$4) | Самый дешёвый платный вариант                      |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM     | $6                                                             | Простой интерфейс, хорошая документация            |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM     | $6                                                             | Много локаций                                      |
| Linode       | Nanode          | 1 vCPU, 1GB RAM     | $5                                                             | Теперь часть Akamai                                |

**Выбор провайдера:**

- DigitalOcean: самый простой UX + предсказуемая настройка (это руководство)
- Hetzner: хорошее соотношение цена/производительность (см. [руководство Hetzner](/install/hetzner))
- Oracle Cloud: может стоить $0/месяц, но более капризен и только ARM (см. [руководство Oracle](/platforms/oracle))

---

## Предварительные требования

- Аккаунт DigitalOcean ([регистрация с $200 бесплатного кредита](https://m.do.co/c/signup))
- Пара SSH-ключей (или готовность использовать аутентификацию по паролю)
- ~20 минут

## 1. Создание Droplet

1. Войдите в [DigitalOcean](https://cloud.digitalocean.com/)
2. Нажмите **Create → Droplets**
3. Выберите:
   - **Region:** Ближайший к вам (или вашим пользователям)
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **$6/mo** (1 vCPU, 1GB RAM, 25GB SSD)
   - **Authentication:** SSH-ключ (рекомендуется) или пароль
4. Нажмите **Create Droplet**
5. Запишите IP-адрес

## 2) Подключение по SSH

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. Установка OpenClaw

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Install OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify
openclaw --version
```

## 4. Запуск онбординга

```bash
openclaw onboard --install-daemon
```

Мастер проведёт вас через:

- Аутентификацию модели (ключи API или OAuth)
- Настройку каналов (Telegram, WhatsApp, Discord и т. д.)
- Токен Gateway (шлюза) (генерируется автоматически)
- Установку демона (systemd)

## 5. Проверка Gateway (шлюза)

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6. Доступ к панели управления

По умолчанию Gateway (шлюз) привязывается к local loopback. Чтобы получить доступ к Control UI:

**Вариант A: SSH-туннель (рекомендуется)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**Вариант B: Tailscale Serve (HTTPS, только loopback)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

Откройте: `https://<magicdns>/`

Примечания:

- Serve оставляет Gateway (шлюз) доступным только через loopback и выполняет аутентификацию через заголовки идентификации Tailscale.
- Чтобы вместо этого требовать токен/пароль, задайте `gateway.auth.allowTailscale: false` или используйте `gateway.auth.mode: "password"`.

**Вариант C: Привязка к tailnet (без Serve)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

Откройте: `http://<tailscale-ip>:18789` (требуется токен).

## 7. Подключение каналов

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# Scan QR code
```

См. [Channels](/channels) для других провайдеров.

---

## Оптимизации для 1GB RAM

Droplet за $6 имеет всего 1GB RAM. Чтобы всё работало стабильно:

### Добавить swap (рекомендуется)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Использовать более лёгкую модель

Если вы сталкиваетесь с OOM, рассмотрите:

- Использование моделей по API (Claude, GPT) вместо локальных моделей
- Установку `agents.defaults.model.primary` на меньшую модель

### Мониторинг памяти

```bash
free -h
htop
```

---

## Постоянство

Все состояния хранятся в:

- `~/.openclaw/` — конфиг, учётные данные, данные сеансов
- `~/.openclaw/workspace/` — рабочее пространство (SOUL.md, память и т. д.)

Они сохраняются при перезагрузках. Периодически делайте резервные копии:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Бесплатная альтернатива Oracle Cloud

Oracle Cloud предлагает ARM-инстансы **Always Free**, которые значительно мощнее любого платного варианта здесь — за $0/месяц.

| Что вы получаете       | Характеристики          |
| ---------------------- | ----------------------- |
| **4 OCPU**             | ARM Ampere A1           |
| **24GB RAM**           | Более чем достаточно    |
| **200GB storage**      | Заблокировать громкость |
| **Навсегда бесплатно** | Без списаний с карты    |

**Caveats:**

- Регистрация может быть капризной (повторите попытку при неудаче)
- Архитектура ARM — большинство вещей работает, но некоторым бинарникам нужны ARM-сборки

Полное руководство по настройке см. в [Oracle Cloud](/platforms/oracle). Советы по регистрации и устранению проблем с процессом подключения см. в этом [руководстве сообщества](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd).

---

## Устранение неполадок

### Gateway (шлюз) не запускается

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### Порт уже используется

```bash
lsof -i :18789
kill <PID>
```

### Нехватка памяти

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## См. также

- [Руководство Hetzner](/install/hetzner) — дешевле и мощнее
- [Установка Docker](/install/docker) — контейнеризированная настройка
- [Tailscale](/gateway/tailscale) — безопасный удалённый доступ
- [Конфигурация](/gateway/configuration) — полный справочник по конфигу
