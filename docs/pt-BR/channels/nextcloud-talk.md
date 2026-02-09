---
summary: "Status de suporte, capacidades e configuração do Nextcloud Talk"
read_when:
  - Trabalhando em recursos do canal Nextcloud Talk
title: "Nextcloud Talk"
---

# Nextcloud Talk (plugin)

Status: suportado via plugin (bot de webhook). Mensagens diretas, salas, reações e mensagens em markdown são suportadas.

## Plugin necessário

O Nextcloud Talk é distribuído como um plugin e não vem incluído na instalação principal.

Instale via CLI (registro npm):

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

Checkout local (ao executar a partir de um repositório git):

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

Se você escolher Nextcloud Talk durante a configuração/integração inicial e um checkout git for detectado,
o OpenClaw oferecerá automaticamente o caminho de instalação local.

Detalhes: [Plugins](/tools/plugin)

## Configuração rápida (iniciante)

1. Instale o plugin do Nextcloud Talk.

2. No seu servidor Nextcloud, crie um bot:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. Ative o bot nas configurações da sala de destino.

4. Configure o OpenClaw:
   - Configuração: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - Ou variáveis de ambiente: `NEXTCLOUD_TALK_BOT_SECRET` (somente conta padrão)

5. Reinicie o gateway (ou conclua a integração inicial).

Configuração mínima:

```json5
{
  channels: {
    "nextcloud-talk": {
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "shared-secret",
      dmPolicy: "pairing",
    },
  },
}
```

## Notas

- Bots não podem iniciar DMs. O usuário deve enviar mensagem ao bot primeiro.
- A URL do webhook deve ser acessível pelo Gateway; defina `webhookPublicUrl` se estiver atrás de um proxy.
- Uploads de mídia não são suportados pela API do bot; a mídia é enviada como URLs.
- O payload do webhook não diferencia DMs de salas; defina `apiUser` + `apiPassword` para habilitar buscas por tipo de sala (caso contrário, DMs são tratadas como salas).

## Controle de acesso (DMs)

- Padrão: `channels.nextcloud-talk.dmPolicy = "pairing"`. Remetentes desconhecidos recebem um código de pareamento.
- Aprovar via:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- DMs públicas: `channels.nextcloud-talk.dmPolicy="open"` mais `channels.nextcloud-talk.allowFrom=["*"]`.
- `allowFrom` corresponde apenas a IDs de usuário do Nextcloud; nomes de exibição são ignorados.

## Salas (grupos)

- Padrão: `channels.nextcloud-talk.groupPolicy = "allowlist"` (restrito por menção).
- Liste salas permitidas com `channels.nextcloud-talk.rooms`:

```json5
{
  channels: {
    "nextcloud-talk": {
      rooms: {
        "room-token": { requireMention: true },
      },
    },
  },
}
```

- Para não permitir salas, mantenha a lista de permissões vazia ou defina `channels.nextcloud-talk.groupPolicy="disabled"`.

## Capacidades

| Funcionalidade    | Status        |
| ----------------- | ------------- |
| Mensagens diretas | Suportado     |
| Ambientes         | Suportado     |
| Tópicos           | Não suportado |
| Mídia             | Somente URL   |
| Reações           | Suportado     |
| Comandos nativos  | Não suportado |

## Referência de configuração (Nextcloud Talk)

Configuração completa: [Configuração](/gateway/configuration)

Opções do provedor:

- `channels.nextcloud-talk.enabled`: habilitar/desabilitar a inicialização do canal.
- `channels.nextcloud-talk.baseUrl`: URL da instância Nextcloud.
- `channels.nextcloud-talk.botSecret`: segredo compartilhado do bot.
- `channels.nextcloud-talk.botSecretFile`: caminho do arquivo de segredo.
- `channels.nextcloud-talk.apiUser`: usuário da API para buscas de salas (detecção de DM).
- `channels.nextcloud-talk.apiPassword`: senha de API/app para buscas de salas.
- `channels.nextcloud-talk.apiPasswordFile`: caminho do arquivo da senha da API.
- `channels.nextcloud-talk.webhookPort`: porta do listener de webhook (padrão: 8788).
- `channels.nextcloud-talk.webhookHost`: host do webhook (padrão: 0.0.0.0).
- `channels.nextcloud-talk.webhookPath`: caminho do webhook (padrão: /nextcloud-talk-webhook).
- `channels.nextcloud-talk.webhookPublicUrl`: URL do webhook acessível externamente.
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`.
- `channels.nextcloud-talk.allowFrom`: lista de permissões de DM (IDs de usuário). `open` requer `"*"`.
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`.
- `channels.nextcloud-talk.groupAllowFrom`: lista de permissões de grupos (IDs de usuário).
- `channels.nextcloud-talk.rooms`: configurações por sala e lista de permissões.
- `channels.nextcloud-talk.historyLimit`: limite de histórico de grupos (0 desativa).
- `channels.nextcloud-talk.dmHistoryLimit`: limite de histórico de DMs (0 desativa).
- `channels.nextcloud-talk.dms`: substituições por DM (historyLimit).
- `channels.nextcloud-talk.textChunkLimit`: tamanho de fragmento de texto de saída (caracteres).
- `channels.nextcloud-talk.chunkMode`: `length` (padrão) ou `newline` para dividir em linhas em branco (limites de parágrafo) antes do fracionamento por comprimento.
- `channels.nextcloud-talk.blockStreaming`: desativar block streaming para este canal.
- `channels.nextcloud-talk.blockStreamingCoalesce`: ajuste de coalescência do block streaming.
- `channels.nextcloud-talk.mediaMaxMb`: limite de mídia de entrada (MB).
