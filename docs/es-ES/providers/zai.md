---
title: Zai
description: Proveedor de Modelos de Lenguaje Grande
icon: brain
---

# Zai

[Zai](https://platform.zaidata.com/) proporciona acceso a diversos modelos de lenguaje grande.

## Inicio rápido

1. Obtén tu clave API desde el [panel de Zai](https://platform.zaidata.com/api-keys)
2. Configura OpenClaw:

```bash
openclaw config set zai.apiKey=sk-xxx
```

3. Establece Zai como tu proveedor predeterminado:

```bash
openclaw config set model.defaultProvider=zai
```

## Configuración

| Clave         | Descripción        | Valor predeterminado         |
| ------------- | ------------------ | ---------------------------- |
| `zai.apiKey`  | Clave API de Zai   | -                            |
| `zai.baseURL` | URL base de la API | `https://api.zaidata.com/v1` |
