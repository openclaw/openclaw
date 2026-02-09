---
summary: "Справочник CLI для `openclaw skills` (list/info/check) и допустимости Skills"
read_when:
  - Вы хотите увидеть, какие Skills доступны и готовы к запуску
  - Вы хотите отладить отсутствующие бинарники/переменные окружения/конфиг для Skills
title: "skills"
---

# `openclaw skills`

Проверяйте Skills (в комплекте + рабочее пространство + управляемые переопределения) и смотрите, какие из них допустимы к запуску, а где отсутствуют требования.

Связанное:

- Система Skills: [Skills](/tools/skills)
- Конфигурация Skills: [Skills config](/tools/skills-config)
- Установки ClawHub: [ClawHub](/tools/clawhub)

## Команды

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```
