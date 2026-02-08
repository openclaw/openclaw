---
summary: "Możliwości OpenClaw w kanałach, routingu, mediach i UX."
read_when:
  - Chcesz uzyskać pełną listę obsługiwanych funkcji OpenClaw
title: "Funkcje"
x-i18n:
  source_path: concepts/features.md
  source_hash: 1b6aee0bfda75182
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:03Z
---

## Najważniejsze informacje

<Columns>
  <Card title="Kanały" icon="message-square">
    WhatsApp, Telegram, Discord oraz iMessage z jednym Gateway.
  </Card>
  <Card title="Wtyczki" icon="plug">
    Dodaj Mattermost i inne dzięki rozszerzeniom.
  </Card>
  <Card title="Routing" icon="route">
    Routing wieloagentowy z izolowanymi sesjami.
  </Card>
  <Card title="Media" icon="image">
    Obrazy, audio i dokumenty — wejście i wyjście.
  </Card>
  <Card title="Aplikacje i interfejs" icon="monitor">
    Web Control UI oraz aplikacja towarzysząca na macOS.
  </Card>
  <Card title="Węzły mobilne" icon="smartphone">
    Węzły iOS i Android z obsługą Canvas.
  </Card>
</Columns>

## Pełna lista

- Integracja z WhatsApp przez WhatsApp Web (Baileys)
- Obsługa botów Telegram (grammY)
- Obsługa botów Discord (channels.discord.js)
- Obsługa botów Mattermost (wtyczka)
- Integracja z iMessage przez lokalne CLI imsg (macOS)
- Most agenta dla Pi w trybie RPC z strumieniowaniem narzędzi
- Strumieniowanie i dzielenie na fragmenty dla długich odpowiedzi
- Routing wieloagentowy dla izolowanych sesji na obszar roboczy lub nadawcę
- Uwierzytelnianie subskrypcyjne dla Anthropic i OpenAI przez OAuth
- Sesje: czaty bezpośrednie są łączone we wspólne `main`; grupy są izolowane
- Obsługa czatów grupowych z aktywacją opartą na wzmiankach
- Obsługa mediów: obrazy, audio i dokumenty
- Opcjonalny hook transkrypcji notatek głosowych
- WebChat oraz aplikacja w pasku menu na macOS
- Węzeł iOS z parowaniem i powierzchnią Canvas
- Węzeł Android z parowaniem, Canvas, czatem i kamerą

<Note>
Starsze ścieżki Claude, Codex, Gemini oraz Opencode zostały usunięte. Pi jest jedyną
ścieżką agenta kodującego.
</Note>
