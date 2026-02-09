---
summary: "Regras de tratamento de imagens e mídia para envios, gateway e respostas de agentes"
read_when:
  - Modificando o pipeline de mídia ou anexos
title: "Suporte a Imagens e Mídia"
---

# Suporte a Imagens e Mídia — 2025-12-05

O canal WhatsApp funciona via **Baileys Web**. Este documento registra as regras atuais de tratamento de mídia para envios, gateway e respostas de agentes.

## Objetivos

- Enviar mídia com legendas opcionais via `openclaw message send --media`.
- Permitir que respostas automáticas da caixa de entrada web incluam mídia junto com texto.
- Manter limites por tipo razoáveis e previsíveis.

## Superfície da CLI

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` opcional; a legenda pode estar vazia para envios somente de mídia.
  - `--dry-run` imprime o payload resolvido; `--json` emite `{ channel, to, messageId, mediaUrl, caption }`.

## Comportamento do canal WhatsApp Web

- Entrada: caminho de arquivo local **ou** URL HTTP(S).
- Fluxo: carregar em um Buffer, detectar o tipo de mídia e construir o payload correto:
  - **Imagens:** redimensionar e recomprimir para JPEG (lado máximo 2048px) visando `agents.defaults.mediaMaxMb` (padrão 5 MB), com limite máximo de 6 MB.
  - **Áudio/Voz/Vídeo:** passagem direta até 16 MB; áudio é enviado como nota de voz (`ptt: true`).
  - **Documentos:** qualquer outro tipo, até 100 MB, com o nome do arquivo preservado quando disponível.
- Reprodução estilo GIF do WhatsApp: enviar um MP4 com `gifPlayback: true` (CLI: `--gif-playback`) para que clientes móveis façam loop inline.
- A detecção de MIME prioriza magic bytes, depois headers e, por fim, a extensão do arquivo.
- A legenda vem de `--message` ou `reply.text`; legenda vazia é permitida.
- Logging: no modo não verboso mostra `↩️`/`✅`; no modo verboso inclui tamanho e caminho/URL de origem.

## Pipeline de Resposta Automática

- `getReplyFromConfig` retorna `{ text?, mediaUrl?, mediaUrls? }`.
- Quando há mídia, o remetente web resolve caminhos locais ou URLs usando o mesmo pipeline de `openclaw message send`.
- Várias entradas de mídia são enviadas sequencialmente quando fornecidas.

## Mídia de Entrada para Comandos (Pi)

- Quando mensagens web de entrada incluem mídia, o OpenClaw baixa para um arquivo temporário e expõe variáveis de template:
  - `{{MediaUrl}}` pseudo-URL para a mídia de entrada.
  - `{{MediaPath}}` caminho temporário local gravado antes de executar o comando.
- Quando um sandbox Docker por sessão está habilitado, a mídia de entrada é copiada para o workspace do sandbox e `MediaPath`/`MediaUrl` são reescritos para um caminho relativo como `media/inbound/<filename>`.
- A compreensão de mídia (se configurada via `tools.media.*` ou compartilhada `tools.media.models`) é executada antes do templating e pode inserir blocos `[Image]`, `[Audio]` e `[Video]` em `Body`.
  - Áudio define `{{Transcript}}` e usa a transcrição para o parsing do comando, para que comandos com barra continuem funcionando.
  - Descrições de vídeo e imagem preservam qualquer texto de legenda para o parsing do comando.
- Por padrão, apenas o primeiro anexo de imagem/áudio/vídeo correspondente é processado; defina `tools.media.<cap>.attachments` para processar vários anexos.

## Limites e Erros

**Limites de envio de saída (envio web do WhatsApp)**

- Imagens: limite de ~6 MB após recompressão.
- Áudio/voz/vídeo: limite de 16 MB; documentos: limite de 100 MB.
- Mídia grande demais ou ilegível → erro claro nos logs e a resposta é ignorada.

**Limites de compreensão de mídia (transcrição/descrição)**

- Imagem (padrão): 10 MB (`tools.media.image.maxBytes`).
- Áudio (padrão): 20 MB (`tools.media.audio.maxBytes`).
- Vídeo (padrão): 50 MB (`tools.media.video.maxBytes`).
- Mídia acima do limite ignora a compreensão, mas as respostas ainda são enviadas com o corpo original.

## Notas para Testes

- Cobrir fluxos de envio + resposta para casos de imagem/áudio/documento.
- Validar recompressão para imagens (limite de tamanho) e a flag de nota de voz para áudio.
- Garantir que respostas com múltiplas mídias sejam distribuídas como envios sequenciais.
