---
summary: "Recursos do OpenClaw em canais, roteamento, mídia e experiência do usuário."
read_when:
  - Você quer uma lista completa do que o OpenClaw suporta
title: "Recursos"
---

## Destaques

<Columns>
  <Card title="Canais" icon="message-square">
    WhatsApp, Telegram, Discord e iMessage com um único Gateway.
  </Card>
  <Card title="Plugins" icon="plug">
    Adicione Mattermost e mais com extensões.
  </Card>
  <Card title="Roteamento" icon="route">
    Roteamento multi-agente com sessões isoladas.
  </Card>
  <Card title="Mídia" icon="image">
    Imagens, áudio e documentos de entrada e saída.
  </Card>
  <Card title="Apps e Interface" icon="monitor">
    Interface de Controle Web e app complementar do macOS.
  </Card>
  <Card title="Nós móveis" icon="smartphone">
    Nós iOS e Android com suporte a Canvas.
  </Card>
</Columns>

## Lista completa

- Integração WhatsApp via WhatsApp Web (Baileys)
- Suporte para bot Telegram (grammY)
- Suporte para bot Discord (channels.discord.js)
- Suporte para bot Mattermost (plugin)
- Integração iMessage via CLI imsg local (macOS)
- Ponte de agente para Pi em modo RPC com streaming de ferramentas
- Streaming e divisão em chunks para respostas longas
- Roteamento multi-agente para sessões isoladas por workspace ou remetente
- Autenticação de assinatura para Anthropic e OpenAI via OAuth
- Sessões: chats diretos são mesclados em `main` compartilhado; grupos são isolados
- Suporte para chat em grupo com ativação baseada em menção
- Suporte para mídia com imagens, áudio e documentos
- Hook opcional de transcrição de notas de voz
- WebChat e app menu bar do macOS
- Nó iOS com emparelhamento e superfície Canvas
- Nó Android com emparelhamento, Canvas, chat e câmera

<Note>
Os caminhos legados Claude, Codex, Gemini e Opencode foram removidos. Pi é o único
caminho de agente de codificação.
</Note>
