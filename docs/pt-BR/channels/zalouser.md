---
summary: "Suporte a conta pessoal do Zalo via zca-cli (login por QR), capacidades e configuração"
read_when:
  - Configurando o Zalo Personal para o OpenClaw
  - Depurando login ou fluxo de mensagens do Zalo Personal
title: "Zalo Personal"
---

# Zalo Personal (não oficial)

Status: experimental. Esta integração automatiza uma **conta pessoal do Zalo** via `zca-cli`.

> **Aviso:** Esta é uma integração não oficial e pode resultar em suspensão/banimento da conta. Use por sua conta e risco.

## Plugin necessário

O Zalo Personal é distribuído como um plugin e não vem incluído na instalação principal.

- Instalar via CLI: `openclaw plugins install @openclaw/zalouser`
- Ou a partir de um checkout do código-fonte: `openclaw plugins install ./extensions/zalouser`
- Detalhes: [Plugins](/tools/plugin)

## Pré-requisito: zca-cli

A máquina do Gateway deve ter o binário `zca` disponível em `PATH`.

- Verificar: `zca --version`
- Se estiver ausente, instale o zca-cli (veja `extensions/zalouser/README.md` ou a documentação oficial do zca-cli).

## Configuração rápida (iniciante)

1. Instale o plugin (veja acima).
2. Faça login (QR, na máquina do Gateway):
   - `openclaw channels login --channel zalouser`
   - Escaneie o código QR no terminal com o aplicativo móvel do Zalo.
3. Ative o canal:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

4. Reinicie o Gateway (ou finalize a integração inicial).
5. O acesso por DM usa pareamento por padrão; aprove o código de pareamento no primeiro contato.

## O que é

- Usa `zca listen` para receber mensagens de entrada.
- Usa `zca msg ...` para enviar respostas (texto/mídia/link).
- Projetado para casos de uso de “conta pessoal”, onde a API oficial de Bot do Zalo não está disponível.

## Nomenclatura

O id do canal é `zalouser` para deixar explícito que isso automatiza uma **conta de usuário pessoal do Zalo** (não oficial). Mantemos `zalo` reservado para uma possível integração futura com a API oficial do Zalo.

## Encontrando IDs (diretório)

Use a CLI de diretório para descobrir contatos/grupos e seus IDs:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## Limites

- O texto de saída é dividido em blocos de ~2000 caracteres (limites do cliente do Zalo).
- O streaming é bloqueado por padrão.

## Controle de acesso (DMs)

`channels.zalouser.dmPolicy` oferece suporte a: `pairing | allowlist | open | disabled` (padrão: `pairing`).
`channels.zalouser.allowFrom` aceita IDs de usuário ou nomes. O assistente resolve nomes para IDs via `zca friend find` quando disponível.

Aprove via:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## Acesso a grupos (opcional)

- Padrão: `channels.zalouser.groupPolicy = "open"` (grupos permitidos). Use `channels.defaults.groupPolicy` para sobrescrever o padrão quando não estiver definido.
- Restrinja a uma lista de permissões com:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (as chaves são IDs ou nomes de grupos)
- Bloquear todos os grupos: `channels.zalouser.groupPolicy = "disabled"`.
- O assistente de configuração pode solicitar listas de permissões de grupos.
- Na inicialização, o OpenClaw resolve nomes de grupos/usuários nas listas de permissões para IDs e registra o mapeamento; entradas não resolvidas são mantidas como digitadas.

Exemplo:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## Multi-conta

As contas mapeiam para perfis do zca. Exemplo:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## Solução de problemas

**`zca` não encontrado:**

- Instale o zca-cli e garanta que ele esteja em `PATH` para o processo do Gateway.

**O login não persiste:**

- `openclaw channels status --probe`
- Faça login novamente: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
