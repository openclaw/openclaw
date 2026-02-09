---
summary: "Сетевой хаб: поверхности Gateway (шлюза), сопряжение, обнаружение и безопасность"
read_when:
  - Вам нужен обзор сетевой архитектуры и безопасности
  - "Вы отлаживаете доступ: локальный vs tailnet, или сопряжение"
  - Вам нужен канонический список сетевой документации
title: "network.md"
---

# Сетевой хаб

Этот хаб связывает основные документы о том, как OpenClaw подключает,
сопрягает и защищает устройства через localhost, LAN и tailnet.

## Базовая модель

- [Архитектура Gateway (шлюза)](/concepts/architecture)
- [Протокол Gateway (шлюза)](/gateway/protocol)
- [Runbook Gateway (шлюза)](/gateway)
- [Веб‑поверхности + режимы привязки](/web)

## Сопряжение + идентификация

- [Обзор сопряжения (DM + узлы)](/channels/pairing)
- [Сопряжение узлов, принадлежащих Gateway (шлюзу)](/gateway/pairing)
- [CLI устройств (сопряжение + ротация токенов)](/cli/devices)
- [CLI сопряжения (подтверждения DM)](/cli/pairing)

Локальное доверие:

- Локальные подключения (local loopback или собственный адрес tailnet хоста шлюза Gateway) могут
  автоматически одобряться для сопряжения, чтобы обеспечить плавный UX на одном хосте.
- Нелокальные клиенты tailnet/LAN по‑прежнему требуют явного одобрения сопряжения.

## Обнаружение + транспорты

- [Обнаружение и транспорты](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [Удалённый доступ (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## Узлы + транспорты

- [Обзор узлов](/nodes)
- [Протокол моста (устаревшие узлы)](/gateway/bridge-protocol)
- [Runbook узла: iOS](/platforms/ios)
- [Runbook узла: Android](/platforms/android)

## Безопасность

- [Обзор безопасности](/gateway/security)
- [Справочник конфигурации Gateway (шлюза)](/gateway/configuration)
- [Устранение неполадок](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
