---
summary: "Estados e animações do ícone da barra de menus do OpenClaw no macOS"
read_when:
  - Alterar o comportamento do ícone da barra de menus
title: "Ícone da Barra de Menus"
---

# Estados do Ícone da Barra de Menus

Autor: steipete · Atualizado: 2025-12-06 · Escopo: app macOS (`apps/macos`)

- **Inativo:** Animação normal do ícone (piscar, leve balançada ocasional).
- **Pausado:** O item de status usa `appearsDisabled`; sem movimento.
- **Gatilho de voz (orelhas grandes):** O detector de ativação por voz chama `AppState.triggerVoiceEars(ttl: nil)` quando a palavra de ativação é ouvida, mantendo `earBoostActive=true` enquanto a fala é capturada. As orelhas aumentam de escala (1,9x), ganham furos circulares para legibilidade e então caem via `stopVoiceEars()` após 1s de silêncio. Disparado apenas a partir do pipeline de voz dentro do app.
- **Trabalhando (agente em execução):** `AppState.isWorking=true` aciona uma microanimação de “corrida de cauda/pernas”: balançada de pernas mais rápida e leve deslocamento enquanto o trabalho está em andamento. Atualmente alternado em torno das execuções do agente WebChat; adicione a mesma alternância em outras tarefas longas quando você as conectar.

Pontos de ligação

- Ativação por voz: o runtime/tester chama `AppState.triggerVoiceEars(ttl: nil)` no gatilho e `stopVoiceEars()` após 1s de silêncio para corresponder à janela de captura.
- Atividade do agente: defina `AppStateStore.shared.setWorking(true/false)` em torno dos períodos de trabalho (já feito na chamada do agente WebChat). Mantenha os períodos curtos e redefina em blocos `defer` para evitar animações presas.

Formas e tamanhos

- Ícone base desenhado em `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`.
- A escala das orelhas tem padrão `1.0`; o impulso de voz define `earScale=1.9` e alterna `earHoles=true` sem alterar o quadro geral (imagem de template 18×18 pt renderizada em um backing store Retina de 36×36 px).
- A corrida usa balançada das pernas até ~1,0 com um pequeno chacoalho horizontal; é aditiva a qualquer balançada inativa existente.

Notas de comportamento

- Não há alternância externa via CLI/broker para orelhas/trabalho; mantenha isso interno aos próprios sinais do app para evitar batidas acidentais.
- Mantenha TTLs curtos (&lt;10s) para que o ícone retorne rapidamente ao estado base se um trabalho travar.
