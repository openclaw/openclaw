---
title: Qwen
description: Proveedor de Modelos de Lenguaje Grande de Alibaba Cloud
icon: cloud
---

# Qwen

[Qwen](https://help.aliyun.com/zh/model-studio/getting-started/models) es la familia de modelos de lenguaje grande de Alibaba Cloud.

## Inicio rápido

1. Obtén tu clave API desde la [consola de Alibaba Cloud](https://bailian.console.aliyun.com/?apiKey=1#/api-key)
2. Configura OpenClaw:

```bash
openclaw config set qwen.apiKey=sk-xxx
```

3. Establece Qwen como tu proveedor predeterminado:

```bash
openclaw config set model.defaultProvider=qwen
openclaw config set model.default=qwen-plus
```

## Configuración

| Clave          | Descripción                | Valor predeterminado                                |
| -------------- | -------------------------- | --------------------------------------------------- |
| `qwen.apiKey`  | Clave API de Alibaba Cloud | -                                                   |
| `qwen.baseURL` | URL base de la API         | `https://dashscope.aliyuncs.com/compatible-mode/v1` |

## Modelos

Consulta [la documentación oficial de Qwen](https://help.aliyun.com/zh/model-studio/getting-started/models) para obtener la lista completa de modelos disponibles.

## Enlaces

- [Sitio web de Qwen](https://help.aliyun.com/zh/model-studio/getting-started/models)
- [Consola de Alibaba Cloud](https://bailian.console.aliyun.com/)
