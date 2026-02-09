---
summary: "OpenClaw в Oracle Cloud (Always Free ARM)"
read_when:
  - Настройка OpenClaw в Oracle Cloud
  - Поиск недорогого VPS-хостинга для OpenClaw
  - Нужен OpenClaw 24/7 на небольшом сервере
title: "Oracle Cloud"
---

# OpenClaw в Oracle Cloud (OCI)

## Цель

Запустить постоянный Gateway (шлюз) OpenClaw в **Always Free** ARM‑тире Oracle Cloud.

Бесплатный тир Oracle хорошо подходит для OpenClaw (особенно если у вас уже есть учётная запись OCI), но у него есть компромиссы:

- ARM‑архитектура (большинство вещей работает, но некоторые бинарники могут быть только x86)
- Мощность и регистрация могут быть окончательно

## Сравнение стоимости (2026)

| Провайдер    | План            | Характеристики       | Цена/мес             | Примечания                       |
| ------------ | --------------- | -------------------- | -------------------- | -------------------------------- |
| Oracle Cloud | Always Free ARM | до 4 OCPU, 24 ГБ RAM | $0                   | ARM, ограниченная ёмкость        |
| Hetzner      | CX22            | 2 vCPU, 4 ГБ RAM     | ~ $4 | Самый дешёвый платный вариант    |
| DigitalOcean | Basic           | 1 vCPU, 1 ГБ RAM     | $6                   | Удобный UI, хорошая документация |
| Vultr        | Cloud Compute   | 1 vCPU, 1 ГБ RAM     | $6                   | Много локаций                    |
| Linode       | Nanode          | 1 vCPU, 1 ГБ RAM     | $5                   | Теперь часть Akamai              |

---

## Предварительные требования

- Учётная запись Oracle Cloud ([регистрация](https://www.oracle.com/cloud/free/)) — при проблемах см. [гайд сообщества по регистрации](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)
- Учётная запись Tailscale (бесплатно на [tailscale.com](https://tailscale.com))
- ~30 минут

## 1. Создание инстанса OCI

1. Войдите в [Oracle Cloud Console](https://cloud.oracle.com/)
2. Перейдите в **Compute → Instances → Create Instance**
3. Настройте:
   - **Name:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (или до 4)
   - **Memory:** 12 ГБ (или до 24 ГБ)
   - **Boot volume:** 50 ГБ (до 200 ГБ бесплатно)
   - **SSH key:** Добавьте ваш публичный ключ
4. Нажмите **Create**
5. Запишите публичный IP‑адрес

**Совет:** если создание инстанса завершается ошибкой «Out of capacity», попробуйте другой домен доступности или повторите попытку позже. Ёмкость бесплатного тира ограничена.

## 2. Подключение и обновление

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**Примечание:** для ARM‑компиляции некоторых зависимостей требуется `build-essential`.

## 3. Настройка пользователя и hostname

```bash
# Set hostname
sudo hostnamectl set-hostname openclaw

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4. Установка Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

Это включает Tailscale SSH, поэтому вы сможете подключаться через `ssh openclaw` с любого устройства в вашем tailnet — публичный IP не нужен.

Проверьте:

```bash
tailscale status
```

**С этого момента подключайтесь через Tailscale:** `ssh ubuntu@openclaw` (или используйте IP Tailscale).

## 5. Установка OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

На вопрос «How do you want to hatch your bot?» выберите **«Do this later»**.

> Примечание: если возникнут проблемы со сборкой под ARM, начните с системных пакетов (например, `sudo apt install -y build-essential`), прежде чем использовать Homebrew.

## 6. Настройка Gateway (шлюз) (loopback + аутентификация по токену) и включение Tailscale Serve

Используйте аутентификацию по токену по умолчанию. Это предсказуемо и не требует каких‑либо флагов Control UI для «небезопасной аутентификации».

```bash
# Keep the Gateway private on the VM
openclaw config set gateway.bind loopback

# Require auth for the Gateway + Control UI
openclaw config set gateway.auth.mode token
openclaw doctor --generate-gateway-token

# Expose over Tailscale Serve (HTTPS + tailnet access)
openclaw config set gateway.tailscale.mode serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart openclaw-gateway
```

## 7. Проверка

```bash
# Check version
openclaw --version

# Check daemon status
systemctl --user status openclaw-gateway

# Check Tailscale Serve
tailscale serve status

# Test local response
curl http://localhost:18789
```

## 8. Усиление безопасности VCN

Теперь, когда всё работает, ограничьте VCN, заблокировав весь трафик, кроме Tailscale. Virtual Cloud Network в OCI действует как firewall на границе сети — трафик блокируется до того, как он достигнет инстанса.

1. В OCI Console перейдите в **Networking → Virtual Cloud Networks**
2. Нажмите на ваш VCN → **Security Lists** → Default Security List
3. **Удалите** все входящие правила, кроме:
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. Оставьте исходящие правила по умолчанию (разрешить весь исходящий трафик)

Это блокирует SSH на порту 22, HTTP, HTTPS и всё остальное на границе сети. С этого момента подключение возможно только через Tailscale.

---

## Доступ к Control UI

С любого устройства в вашей сети Tailscale:

```
https://openclaw.<tailnet-name>.ts.net/
```

Замените `<tailnet-name>` на имя вашего tailnet (видно в `tailscale status`).

SSH‑туннель не требуется. Tailscale предоставляет:

- HTTPS‑шифрование (автоматические сертификаты)
- Аутентификацию через учётную запись Tailscale
- Доступ с любого устройства в вашем tailnet (ноутбук, телефон и т. д.)

---

## Безопасность: VCN + Tailscale (рекомендуемая базовая конфигурация)

При заблокированном VCN (открыт только UDP 41641) и Gateway (шлюз), привязанном к loopback, вы получаете сильную многоуровневую защиту: публичный трафик блокируется на границе сети, а административный доступ осуществляется через ваш tailnet.

Такая конфигурация часто устраняет _необходимость_ в дополнительных host‑based firewall‑правилах исключительно для защиты от массового SSH‑брутфорса из интернета — однако всё равно следует поддерживать ОС в актуальном состоянии, выполнять `openclaw security audit` и проверять, что вы случайно не слушаете публичные интерфейсы.

### Что уже защищено

| Традиционный шаг | Нужен?     | Почему                                                                     |
| ---------------- | ---------- | -------------------------------------------------------------------------- |
| Firewall UFW     | Нет        | VCN блокирует трафик до попадания на инстанс                               |
| fail2ban         | Нет        | Нет брутфорса, если порт 22 заблокирован на уровне VCN                     |
| Ужесточение sshd | Нет        | Tailscale SSH не использует sshd                                           |
| Отключение root  | Нет        | Tailscale использует идентификацию Tailscale, а не системных пользователей |
| Только ключи SSH | Нет        | Tailscale аутентифицирует через ваш tailnet                                |
| Усиление IPv6    | Обычно нет | Зависит от настроек VCN/подсети; проверьте, что реально назначено/открыто  |

### Всё ещё рекомендуется

- **Права доступа к учётным данным:** `chmod 700 ~/.openclaw`
- **Аудит безопасности:** `openclaw security audit`
- **Обновления системы:** регулярно выполняйте `sudo apt update && sudo apt upgrade`
- **Мониторинг Tailscale:** проверяйте устройства в [консоли администратора Tailscale](https://login.tailscale.com/admin)

### Проверка уровня безопасности

```bash
# Confirm no public ports listening
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verify Tailscale SSH is active
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# Optional: disable sshd entirely
sudo systemctl disable --now ssh
```

---

## Резервный вариант: SSH‑туннель

Если Tailscale Serve не работает, используйте SSH‑туннель:

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

Затем откройте `http://localhost:18789`.

---

## Устранение неполадок

### Не удаётся создать инстанс («Out of capacity»)

Бесплатные ARM‑инстансы популярны. Попробуйте:

- Другой домен доступности
- Повторить попытку в непиковое время (раннее утро)
- Использовать фильтр «Always Free» при выборе shape

### Tailscale не подключается

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway (шлюз) не запускается

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### Не удаётся открыть Control UI

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway
```

### Проблемы с ARM‑бинарниками

Некоторые инструменты могут не иметь ARM‑сборок. Проверьте:

```bash
uname -m  # Should show aarch64
```

Большинство npm‑пакетов работает нормально. Для бинарников ищите релизы `linux-arm64` или `aarch64`.

---

## Постоянство

Все состояния хранятся в:

- `~/.openclaw/` — конфиг, учётные данные, данные сеансов
- `~/.openclaw/workspace/` — рабочее пространство (SOUL.md, память, артефакты)

Периодически делайте резервные копии:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## См. также

- [Удалённый доступ к Gateway](/gateway/remote) — другие схемы удалённого доступа
- [Интеграция с Tailscale](/gateway/tailscale) — полная документация по Tailscale
- [Конфигурация Gateway](/gateway/configuration) — все параметры конфигурации
- [Руководство по DigitalOcean](/platforms/digitalocean) — если нужен платный вариант с более простой регистрацией
- [Руководство по Hetzner](/install/hetzner) — альтернатива на базе Docker
