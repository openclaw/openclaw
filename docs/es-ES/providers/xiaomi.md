---
title: Xiaomi
description: Proveedor de Modelos de Lenguaje Grande de Xiaomi
icon: mobile
---

# Xiaomi

[Xiaomi AI](https://platform.moonshot.cn/) proporciona acceso a modelos de lenguaje grande.

## Inicio rápido

1. Obtén tu clave API desde la [plataforma de Xiaomi AI](https://platform.moonshot.cn/console/api-keys)
2. Configura OpenClaw:

```bash
openclaw config set xiaomi.apiKey=sk-xxx
```

3. Establece Xiaomi como tu proveedor predeterminado:

```bash
openclaw config set model.defaultProvider=xiaomi
openclaw config set model.default=xiaomi-model
```

## Configuración

| Clave            | Descripción         | Valor predeterminado         |
| ---------------- | ------------------- | ---------------------------- |
| `xiaomi.apiKey`  | Clave API de Xiaomi | -                            |
| `xiaomi.baseURL` | URL base de la API  | `https://api.moonshot.cn/v1` |

## Modelos

Consulta [la documentación oficial de Xiaomi](https://platform.moonshot.cn/docs) para obtener la lista completa de modelos disponibles.

## Enlaces

- [Sitio web de Xiaomi AI](https://platform.moonshot.cn/)
- [Documentación de la API](https://platform.moonshot.cn/docs)
- [Consola de Xiaomi AI](https://platform.moonshot.cn/console)
