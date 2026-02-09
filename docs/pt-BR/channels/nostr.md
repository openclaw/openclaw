---
summary: "Canal de DM do Nostr via mensagens criptografadas NIP-04"
read_when:
  - Você quer que o OpenClaw receba DMs via Nostr
  - Você está configurando mensagens descentralizadas
title: "Nostr"
---

# Nostr

**Status:** Plugin opcional (desativado por padrão).

Nostr é um protocolo descentralizado para redes sociais. Este canal permite que o OpenClaw receba e responda a mensagens diretas (DMs) criptografadas via NIP-04.

## Instalação (sob demanda)

### Onboarding (recomendado)

- O assistente de onboarding (`openclaw onboard`) e `openclaw channels add` listam plugins de canal opcionais.
- Ao selecionar Nostr, você é solicitado a instalar o plugin sob demanda.

Padrões de instalação:

- **Canal Dev + git checkout disponível:** usa o caminho local do plugin.
- **Stable/Beta:** baixa do npm.

Você sempre pode substituir a escolha no prompt.

### Instalação manual

```bash
openclaw plugins install @openclaw/nostr
```

Use um checkout local (fluxos de trabalho de dev):

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

Reinicie o Gateway após instalar ou habilitar plugins.

## Configuração rápida

1. Gere um par de chaves Nostr (se necessário):

```bash
# Using nak
nak key generate
```

2. Adicione à configuração:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. Exporte a chave:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Reinicie o Gateway.

## Referência de configuração

| Chave        | Tipo                                                         | Padrão                                      | Descrição                                    |
| ------------ | ------------------------------------------------------------ | ------------------------------------------- | -------------------------------------------- |
| `privateKey` | string                                                       | required                                    | Chave privada em `nsec` ou formato hex       |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | URLs de relay (WebSocket) |
| `dmPolicy`   | string                                                       | `pairing`                                   | Política de acesso a DMs                     |
| `allowFrom`  | string[] | `[]`                                        | Pubkeys de remetentes permitidos             |
| `enabled`    | boolean                                                      | `true`                                      | Ativar/desativar canal                       |
| `name`       | string                                                       | -                                           | Nome de exibição                             |
| `profile`    | object                                                       | -                                           | Metadados de perfil NIP-01                   |

## Metadados de perfil

Os dados do perfil são publicados como um evento NIP-01 `kind:0`. Você pode gerenciá-los pela UI de Controle (Canais -> Nostr -> Perfil) ou defini-los diretamente na configuração.

Exemplo:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "profile": {
        "name": "openclaw",
        "displayName": "OpenClaw",
        "about": "Personal assistant DM bot",
        "picture": "https://example.com/avatar.png",
        "banner": "https://example.com/banner.png",
        "website": "https://example.com",
        "nip05": "openclaw@example.com",
        "lud16": "openclaw@example.com"
      }
    }
  }
}
```

Notas:

- URLs de perfil devem usar `https://`.
- Importar de relays mescla campos e preserva substituições locais.

## Controle de acesso

### Políticas de DM

- **pairing** (padrão): remetentes desconhecidos recebem um código de pareamento.
- **allowlist**: apenas pubkeys em `allowFrom` podem enviar DM.
- **open**: DMs públicas de entrada (requer `allowFrom: ["*"]`).
- **disabled**: ignora DMs de entrada.

### Exemplo de allowlist

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1abc...", "npub1xyz..."]
    }
  }
}
```

## Formatos de chave

Formatos aceitos:

- **Chave privada:** `nsec...` ou hex de 64 caracteres
- **Pubkeys (`allowFrom`):** `npub...` ou hex

## Relays

Padrões: `relay.damus.io` e `nos.lol`.

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"]
    }
  }
}
```

Dicas:

- Use 2–3 relays para redundância.
- Evite muitos relays (latência, duplicação).
- Relays pagos podem melhorar a confiabilidade.
- Relays locais são adequados para testes (`ws://localhost:7777`).

## Suporte ao protocolo

| NIP    | Status    | Descrição                                        |
| ------ | --------- | ------------------------------------------------ |
| NIP-01 | Suportado | Formato básico de eventos + metadados de perfil  |
| NIP-04 | Suportado | DMs criptografadas (`kind:4`) |
| NIP-17 | Planejado | DMs com gift-wrap                                |
| NIP-44 | Planejado | Criptografia versionada                          |

## Testes

### Relay local

```bash
# Start strfry
docker run -p 7777:7777 ghcr.io/hoytech/strfry
```

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["ws://localhost:7777"]
    }
  }
}
```

### Teste manual

1. Anote a pubkey do bot (npub) nos logs.
2. Abra um cliente Nostr (Damus, Amethyst, etc.).
3. Envie DM para a pubkey do bot.
4. Verifique a resposta.

## Solução de problemas

### Não recebe mensagens

- Verifique se a chave privada é válida.
- Garanta que as URLs de relay sejam acessíveis e usem `wss://` (ou `ws://` para local).
- Confirme que `enabled` não está `false`.
- Verifique os logs do Gateway para erros de conexão com relays.

### Não envia respostas

- Verifique se o relay aceita escritas.
- Verifique a conectividade de saída.
- Observe limites de taxa do relay.

### Respostas duplicadas

- Esperado ao usar múltiplos relays.
- As mensagens são deduplicadas por ID de evento; apenas a primeira entrega dispara uma resposta.

## Segurança

- Nunca versionar chaves privadas.
- Use variáveis de ambiente para chaves.
- Considere `allowlist` para bots de produção.

## Limitações (MVP)

- Apenas mensagens diretas (sem chats em grupo).
- Sem anexos de mídia.
- Apenas NIP-04 (gift-wrap do NIP-17 planejado).
