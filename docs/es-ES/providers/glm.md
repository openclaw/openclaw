---
title: GLM
description: Proveedor de Modelos de Lenguaje Grande de Zhipu AI
icon: sparkles
---

# GLM

[GLM](https://open.bigmodel.cn/) es la familia de modelos de lenguaje grande de Zhipu AI.

## Inicio rápido

1. Obtén tu clave API desde la [plataforma de Zhipu AI](https://open.bigmodel.cn/usercenter/apikeys)
2. Configura OpenClaw:

```bash
openclaw config set glm.apiKey=xxx
```

3. Establece GLM como tu proveedor predeterminado:

```bash
openclaw config set model.defaultProvider=glm
openclaw config set model.default=glm-4
```

## Configuración

| Clave         | Descripción           | Valor predeterminado                   |
| ------------- | --------------------- | -------------------------------------- |
| `glm.apiKey`  | Clave API de Zhipu AI | -                                      |
| `glm.baseURL` | URL base de la API    | `https://open.bigmodel.cn/api/paas/v4` |
