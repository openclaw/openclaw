---
summary: "Como o OpenClaw faz a rotação de perfis de autenticação e o fallback entre modelos"
read_when:
  - Diagnosticar rotação de perfis de autenticação, cooldowns ou comportamento de fallback de modelos
  - Atualizar regras de failover para perfis de autenticação ou modelos
title: "Failover de modelo"
---

# Failover de modelo

O OpenClaw lida com falhas em duas etapas:

1. **Rotação de perfis de autenticação** dentro do provedor atual.
2. **Fallback de modelo** para o próximo modelo em `agents.defaults.model.fallbacks`.

Este documento explica as regras de execução e os dados que as sustentam.

## Armazenamento de autenticação (chaves + OAuth)

O OpenClaw usa **perfis de autenticação** tanto para chaves de API quanto para tokens OAuth.

- Segredos ficam em `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (legado: `~/.openclaw/agent/auth-profiles.json`).
- As configurações `auth.profiles` / `auth.order` são **apenas metadados + roteamento** (sem segredos).
- Arquivo OAuth legado apenas para importação: `~/.openclaw/credentials/oauth.json` (importado para `auth-profiles.json` no primeiro uso).

Mais detalhes: [/concepts/oauth](/concepts/oauth)

Tipos de credenciais:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ `projectId`/`enterpriseUrl` para alguns provedores)

## IDs de perfil

Logins OAuth criam perfis distintos para que várias contas possam coexistir.

- Padrão: `provider:default` quando nenhum e‑mail está disponível.
- OAuth com e‑mail: `provider:<email>` (por exemplo, `google-antigravity:user@gmail.com`).

Os perfis ficam em `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` sob `profiles`.

## Ordem de rotação

Quando um provedor tem vários perfis, o OpenClaw escolhe uma ordem assim:

1. **Configuração explícita**: `auth.order[provider]` (se definida).
2. **Perfis configurados**: `auth.profiles` filtrados por provedor.
3. **Perfis armazenados**: entradas em `auth-profiles.json` para o provedor.

Se nenhuma ordem explícita estiver configurada, o OpenClaw usa uma ordem round‑robin:

- **Chave primária:** tipo de perfil (**OAuth antes de chaves de API**).
- **Chave secundária:** `usageStats.lastUsed` (mais antigos primeiro, dentro de cada tipo).
- **Perfis em cooldown/desativados** são movidos para o final, ordenados pelo vencimento mais próximo.

### Afinidade de sessão (amigável a cache)

O OpenClaw **fixa o perfil de autenticação escolhido por sessão** para manter os caches do provedor aquecidos.
Ele **não** rotaciona a cada requisição. O perfil fixado é reutilizado até que:

- a sessão seja redefinida (`/new` / `/reset`)
- uma compactação seja concluída (o contador de compactação incrementa)
- o perfil entre em cooldown ou seja desativado

A seleção manual via `/model …@<profileId>` define uma **substituição do usuário** para aquela sessão
e não é rotacionada automaticamente até que uma nova sessão comece.

Perfis fixados automaticamente (selecionados pelo roteador de sessão) são tratados como uma **preferência**:
eles são tentados primeiro, mas o OpenClaw pode rotacionar para outro perfil em caso de limites de taxa/timeouts.
Perfis fixados pelo usuário permanecem travados naquele perfil; se ele falhar e houver fallbacks de modelo
configurados, o OpenClaw avança para o próximo modelo em vez de trocar de perfil.

### Por que o OAuth pode “parecer perdido”

Se você tiver tanto um perfil OAuth quanto um perfil de chave de API para o mesmo provedor, o round‑robin pode alternar entre eles ao longo das mensagens, a menos que estejam fixados. Para forçar um único perfil:

- Fixe com `auth.order[provider] = ["provider:profileId"]`, ou
- Use uma substituição por sessão via `/model …` com um override de perfil (quando suportado pela sua UI/superfície de chat).

## Cooldowns

Quando um perfil falha devido a erros de autenticação/limite de taxa (ou um timeout que pareça
limite de taxa), o OpenClaw o marca em cooldown e passa para o próximo perfil.
Erros de formato/requisição inválida (por exemplo, falhas de validação de ID de chamada de ferramenta
do Cloud Code Assist) são tratados como elegíveis a failover e usam os mesmos cooldowns.

Os cooldowns usam backoff exponencial:

- 1 minuto
- 5 minutos
- 25 minutos
- 1 hora (limite)

O estado é armazenado em `auth-profiles.json` sob `usageStats`:

```json
{
  "usageStats": {
    "provider:profile": {
      "lastUsed": 1736160000000,
      "cooldownUntil": 1736160600000,
      "errorCount": 2
    }
  }
}
```

## Desativações por cobrança

Falhas de cobrança/crédito (por exemplo, “créditos insuficientes” / “saldo de crédito muito baixo”) são tratadas como elegíveis a failover, mas geralmente não são transitórias. Em vez de um cooldown curto, o OpenClaw marca o perfil como **desativado** (com um backoff mais longo) e rotaciona para o próximo perfil/provedor.

O estado é armazenado em `auth-profiles.json`:

```json
{
  "usageStats": {
    "provider:profile": {
      "disabledUntil": 1736178000000,
      "disabledReason": "billing"
    }
  }
}
```

Padrões:

- O backoff de cobrança começa em **5 horas**, dobra a cada falha de cobrança e tem limite de **24 horas**.
- Os contadores de backoff são redefinidos se o perfil não falhar por **24 horas** (configurável).

## Fallback de modelo

Se todos os perfis de um provedor falharem, o OpenClaw passa para o próximo modelo em
`agents.defaults.model.fallbacks`. Isso se aplica a falhas de autenticação, limites de taxa e
timeouts que esgotaram a rotação de perfis (outros erros não avançam o fallback).

Quando uma execução começa com um override de modelo (hooks ou CLI), os fallbacks ainda terminam em
`agents.defaults.model.primary` após tentar quaisquer fallbacks configurados.

## Configuração relacionada

Veja [Configuração do Gateway](/gateway/configuration) para:

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- roteamento `agents.defaults.imageModel`

Veja [Modelos](/concepts/models) para a visão geral mais ampla de seleção de modelos e fallback.
