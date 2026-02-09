---
summary: "Use a API unificada da Qianfan para acessar muitos modelos no OpenClaw"
read_when:
  - Você quer uma única chave de API para muitos LLMs
  - Você precisa de orientações de configuração do Baidu Qianfan
title: "Qianfan"
---

# Guia do Provedor Qianfan

Qianfan é a plataforma MaaS da Baidu e fornece uma **API unificada** que encaminha solicitações para muitos modelos por trás de um único endpoint e chave de API. Ela é compatível com OpenAI, portanto a maioria dos SDKs da OpenAI funciona ao trocar a URL base.

## Pré-requisitos

1. Uma conta do Baidu Cloud com acesso à API do Qianfan
2. Uma chave de API do console do Qianfan
3. OpenClaw instalado no seu sistema

## Como obter sua chave de API

1. Visite o [Console do Qianfan](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. Crie um novo aplicativo ou selecione um existente
3. Gere uma chave de API (formato: `bce-v3/ALTAK-...`)
4. Copie a chave de API para uso com o OpenClaw

## configuração da CLI

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## Documentos relacionados

- [Configuração do OpenClaw](/gateway/configuration)
- [Provedores de modelos](/concepts/model-providers)
- [Configuração de agente](/concepts/agent)
- [Documentação da API do Qianfan](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
