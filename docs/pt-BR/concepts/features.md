---
summary: "Capacidades do OpenClaw em canais, roteamento, mídia e UX."
read_when:
  - Voce quer uma lista completa do que o OpenClaw oferece
title: "Funcionalidades"
---

## Destaques

<Columns>
  <Card title="Channels" icon="message-square">
    WhatsApp, Telegram, Discord e iMessage com um único Gateway.
  </Card>
  <Card title="Plugins" icon="plug">
    Adicione Mattermost e mais com extensões.
  </Card>
  <Card title="Routing" icon="route">
    Roteamento multiagente com sessões isoladas.
  </Card>
  <Card title="Media" icon="image">
    Imagens, áudio e documentos de entrada e saída.
  </Card>
  <Card title="Apps and UI" icon="monitor">
    UI de Controle Web e aplicativo complementar para macOS.
  </Card>
  <Card title="Mobile nodes" icon="smartphone">
    Nós iOS e Android com suporte a Canvas.
  </Card>
</Columns>

## Lista completa

- Integração com WhatsApp via WhatsApp Web (Baileys)
- Suporte a bot do Telegram (grammY)
- Suporte a bot do Discord (channels.discord.js)
- Suporte a bot do Mattermost (plugin)
- Integração com iMessage via CLI local imsg (macOS)
- Ponte de agente para Pi em modo RPC com streaming de ferramentas
- Streaming e divisão em blocos para respostas longas
- Roteamento multiagente para sessões isoladas por workspace ou remetente
- Autenticação por assinatura para Anthropic e OpenAI via OAuth
- Sessões: chats diretos colapsam em `main`; grupos são isolados
- Suporte a chat em grupo com ativação baseada em menção
- Suporte a mídia para imagens, áudio e documentos
- Gancho opcional de transcrição de notas de voz
- WebChat e aplicativo de barra de menu do macOS
- Nó iOS com pareamento e superfície Canvas
- Nó Android com pareamento, Canvas, chat e câmera

<Note>
Caminhos legados de Claude, Codex, Gemini e Opencode foram removidos. Pi é o único
caminho de agente de codificação.
</Note>
