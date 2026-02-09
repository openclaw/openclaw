---
summary: "Use la API unificada de Qianfan para acceder a muchos modelos en OpenClaw"
read_when:
  - Quiere una sola clave de API para muchos LLM
  - Necesita orientación para la configuración de Baidu Qianfan
title: "Qianfan"
---

# Guía del proveedor Qianfan

Qianfan es la plataforma MaaS de Baidu y proporciona una **API unificada** que enruta solicitudes a muchos modelos detrás de un único
endpoint y una sola clave de API. Es compatible con OpenAI, por lo que la mayoría de los SDK de OpenAI funcionan cambiando la URL base.

## Requisitos previos

1. Una cuenta de Baidu Cloud con acceso a la API de Qianfan
2. Una clave de API desde la consola de Qianfan
3. OpenClaw instalado en su sistema

## Obtención de su clave de API

1. Visite la [Consola de Qianfan](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. Cree una nueva aplicación o seleccione una existente
3. Genere una clave de API (formato: `bce-v3/ALTAK-...`)
4. Copie la clave de API para usarla con OpenClaw

## Configuración de la CLI

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## Documentación relacionada

- [Configuración de OpenClaw](/gateway/configuration)
- [Proveedores de modelos](/concepts/model-providers)
- [Configuración de agentes](/concepts/agent)
- [Documentación de la API de Qianfan](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
