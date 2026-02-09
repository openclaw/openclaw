---
summary: "Exploração: configuração de modelo, perfis de autenticação e comportamento de fallback"
read_when:
  - Explorando ideias futuras de seleção de modelos + perfis de autenticação
title: "Exploração de Configuração de Modelo"
---

# Configuração de Modelo (Exploração)

Este documento registra **ideias** para a configuração futura de modelos. Não é uma
especificação pronta para envio. Para o comportamento atual, veja:

- [Models](/concepts/models)
- [Model failover](/concepts/model-failover)
- [OAuth + profiles](/concepts/oauth)

## Motivação

Operadores querem:

- Vários perfis de autenticação por provedor (pessoal vs. trabalho).
- Seleção simples de `/model` com fallbacks previsíveis.
- Separação clara entre modelos de texto e modelos com capacidade de imagem.

## Possível direção (alto nível)

- Manter a seleção de modelos simples: `provider/model` com aliases opcionais.
- Permitir que provedores tenham vários perfis de autenticação, com uma ordem explícita.
- Usar uma lista global de fallback para que todas as sessões façam failover de forma consistente.
- Substituir o roteamento de imagens apenas quando configurado explicitamente.

## Perguntas em aberto

- A rotação de perfis deve ser por provedor ou por modelo?
- Como a UI deve apresentar a seleção de perfis para uma sessão?
- Qual é o caminho de migração mais seguro a partir de chaves de configuração legadas?
