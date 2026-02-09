---
summary: "Status de suporte do bot Zalo, capacidades e configuração"
read_when:
  - Trabalhando em recursos ou webhooks do Zalo
title: "Zalo"
---

# Zalo (Bot API)

Status: experimental. Apenas mensagens diretas; grupos em breve, conforme a documentação do Zalo.

## Plugin necessário

O Zalo é distribuído como um plugin e não vem incluído na instalação principal.

- Instale via CLI: `openclaw plugins install @openclaw/zalo`
- Ou selecione **Zalo** durante a integração inicial e confirme o prompt de instalação
- Detalhes: [Plugins](/tools/plugin)

## Configuração rápida (iniciante)

1. Instale o plugin do Zalo:
   - A partir de um checkout do código-fonte: `openclaw plugins install ./extensions/zalo`
   - A partir do npm (se publicado): `openclaw plugins install @openclaw/zalo`
   - Ou escolha **Zalo** na integração inicial e confirme o prompt de instalação
2. Defina o token:
   - Env: `ZALO_BOT_TOKEN=...`
   - Ou configuração: `channels.zalo.botToken: "..."`.
3. Reinicie o gateway (ou conclua a integração inicial).
4. O acesso por DM usa pareamento por padrão; aprove o código de pareamento no primeiro contato.

Configuração mínima:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

## O que é

Zalo é um aplicativo de mensagens focado no Vietnã; sua Bot API permite que o Gateway execute um bot para conversas 1:1.
É uma boa opção para suporte ou notificações quando você deseja roteamento determinístico de volta para o Zalo.

- Um canal da Zalo Bot API pertencente ao Gateway.
- Roteamento determinístico: as respostas voltam para o Zalo; o modelo nunca escolhe canais.
- DMs compartilham a sessão principal do agente.
- Grupos ainda não são suportados (a documentação do Zalo indica "em breve").

## Configuração (caminho rápido)

### 1. Criar um token de bot (Zalo Bot Platform)

1. Acesse [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) e faça login.
2. Crie um novo bot e configure suas opções.
3. Copie o token do bot (formato: `12345689:abc-xyz`).

### 2) Configurar o token (env ou configuração)

Exemplo:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

Opção via env: `ZALO_BOT_TOKEN=...` (funciona apenas para a conta padrão).

Suporte a múltiplas contas: use `channels.zalo.accounts` com tokens por conta e `name` opcional.

3. Reinicie o gateway. O Zalo inicia quando um token é resolvido (env ou configuração).
4. O acesso por DM usa pareamento por padrão. Aprove o código quando o bot for contatado pela primeira vez.

## Como funciona (comportamento)

- Mensagens de entrada são normalizadas no envelope de canal compartilhado com placeholders de mídia.
- As respostas sempre retornam para o mesmo chat do Zalo.
- Long-polling por padrão; modo webhook disponível com `channels.zalo.webhookUrl`.

## Limites

- Texto de saída é dividido em blocos de 2000 caracteres (limite da API do Zalo).
- Downloads/uploads de mídia são limitados por `channels.zalo.mediaMaxMb` (padrão 5).
- Streaming é bloqueado por padrão devido ao limite de 2000 caracteres tornar o streaming menos útil.

## Controle de acesso (DMs)

### Acesso por DM

- Padrão: `channels.zalo.dmPolicy = "pairing"`. Remetentes desconhecidos recebem um código de pareamento; as mensagens são ignoradas até a aprovação (os códigos expiram após 1 hora).
- Aprovar via:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- O pareamento é a troca de token padrão. Detalhes: [Pairing](/channels/pairing)
- `channels.zalo.allowFrom` aceita IDs numéricos de usuários (não há busca por nome de usuário).

## Long-polling vs webhook

- Padrão: long-polling (não requer URL pública).
- Modo webhook: defina `channels.zalo.webhookUrl` e `channels.zalo.webhookSecret`.
  - O segredo do webhook deve ter de 8 a 256 caracteres.
  - A URL do webhook deve usar HTTPS.
  - O Zalo envia eventos com o cabeçalho `X-Bot-Api-Secret-Token` para verificação.
  - O HTTP do Gateway trata requisições de webhook em `channels.zalo.webhookPath` (padrão é o caminho da URL do webhook).

**Nota:** getUpdates (polling) e webhook são mutuamente exclusivos conforme a documentação da API do Zalo.

## Tipos de mensagens suportados

- **Mensagens de texto**: Suporte completo com divisão em blocos de 2000 caracteres.
- **Mensagens de imagem**: Baixar e processar imagens de entrada; enviar imagens via `sendPhoto`.
- **Figurinhas**: Registradas em log, mas não totalmente processadas (sem resposta do agente).
- **Tipos não suportados**: Registrados em log (por exemplo, mensagens de usuários protegidos).

## Capacidades

| Funcionalidade                     | Status                                                      |
| ---------------------------------- | ----------------------------------------------------------- |
| Mensagens diretas                  | ✅ Suportado                                                 |
| Grupos                             | ❌ Em breve (conforme docs do Zalo)       |
| Mídia (imagens) | ✅ Suportado                                                 |
| Reações                            | ❌ Não suportado                                             |
| Tópicos                            | ❌ Não suportado                                             |
| Enquetes                           | ❌ Não suportado                                             |
| Comandos nativos                   | ❌ Não suportado                                             |
| Streaming                          | ⚠️ Bloqueado (limite de 2000 caracteres) |

## Destinos de entrega (CLI/cron)

- Use um ID de chat como destino.
- Exemplo: `openclaw message send --channel zalo --target 123456789 --message "hi"`.

## Solução de problemas

**O bot não responde:**

- Verifique se o token é válido: `openclaw channels status --probe`
- Confirme se o remetente está aprovado (pareamento ou allowFrom)
- Verifique os logs do gateway: `openclaw logs --follow`

**Webhook não está recebendo eventos:**

- Garanta que a URL do webhook use HTTPS
- Verifique se o token secreto tem de 8 a 256 caracteres
- Confirme que o endpoint HTTP do gateway está acessível no caminho configurado
- Verifique se o polling getUpdates não está em execução (são mutuamente exclusivos)

## Referência de configuração (Zalo)

Configuração completa: [Configuration](/gateway/configuration)

Opções do provedor:

- `channels.zalo.enabled`: habilitar/desabilitar a inicialização do canal.
- `channels.zalo.botToken`: token do bot da Zalo Bot Platform.
- `channels.zalo.tokenFile`: ler o token a partir de um caminho de arquivo.
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (padrão: pareamento).
- `channels.zalo.allowFrom`: lista de permissões de DM (IDs de usuários). `open` requer `"*"`. O assistente solicitará IDs numéricos.
- `channels.zalo.mediaMaxMb`: limite de mídia de entrada/saída (MB, padrão 5).
- `channels.zalo.webhookUrl`: habilitar modo webhook (HTTPS obrigatório).
- `channels.zalo.webhookSecret`: segredo do webhook (8-256 caracteres).
- `channels.zalo.webhookPath`: caminho do webhook no servidor HTTP do gateway.
- `channels.zalo.proxy`: URL de proxy para requisições da API.

Opções de múltiplas contas:

- `channels.zalo.accounts.<id>.botToken`: token por conta.
- `channels.zalo.accounts.<id>.tokenFile`: arquivo de token por conta.
- `channels.zalo.accounts.<id>.name`: nome de exibição.
- `channels.zalo.accounts.<id>.enabled`: habilitar/desabilitar a conta.
- `channels.zalo.accounts.<id>.dmPolicy`: política de DM por conta.
- `channels.zalo.accounts.<id>.allowFrom`: lista de permissões por conta.
- `channels.zalo.accounts.<id>.webhookUrl`: URL de webhook por conta.
- `channels.zalo.accounts.<id>.webhookSecret`: segredo de webhook por conta.
- `channels.zalo.accounts.<id>.webhookPath`: caminho de webhook por conta.
- `channels.zalo.accounts.<id>.proxy`: URL de proxy por conta.
