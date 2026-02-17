---
summary: "Usa la API unificada de Qianfan para acceder a muchos modelos en OpenClaw"
read_when:
  - Quieres una sola clave API para muchos LLMs
  - Necesitas guía de configuración de Baidu Qianfan
title: "Qianfan"
---

# Guía del proveedor Qianfan

Qianfan es la plataforma MaaS de Baidu, proporciona una **API unificada** que enruta solicitudes a muchos modelos detrás de un
único endpoint y clave API. Es compatible con OpenAI, así que la mayoría de los SDKs de OpenAI funcionan cambiando la URL base.

## Requisitos previos

1. Una cuenta de Baidu Cloud con acceso a la API de Qianfan
2. Una clave API desde la consola de Qianfan
3. OpenClaw instalado en tu sistema

## Obtener tu clave API

1. Visita la [Consola de Qianfan](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. Crea una nueva aplicación o selecciona una existente
3. Genera una clave API (formato: `bce-v3/ALTAK-...`)
4. Copia la clave API para usar con OpenClaw

## Configuración CLI

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## Documentación relacionada

- [Configuración de OpenClaw](/es-ES/gateway/configuration)
- [Proveedores de modelo](/es-ES/concepts/model-providers)
- [Configuración de agente](/es-ES/concepts/agent)
- [Documentación de la API de Qianfan](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
