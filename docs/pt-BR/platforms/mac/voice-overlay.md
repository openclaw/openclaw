---
summary: "Ciclo de vida do overlay de voz quando palavra de ativação e push-to-talk se sobrepõem"
read_when:
  - Ajustando o comportamento do overlay de voz
title: "Overlay de Voz"
---

# Ciclo de Vida do Overlay de Voz (macOS)

Público: contribuidores do app macOS. Objetivo: manter o overlay de voz previsível quando palavra de ativação e push-to-talk se sobrepõem.

## Intenção atual

- Se o overlay já estiver visível por causa da palavra de ativação e o usuário pressionar a tecla de atalho, a sessão de hotkey _adota_ o texto existente em vez de redefini-lo. O overlay permanece visível enquanto a hotkey estiver pressionada. Quando o usuário soltar: envia se houver texto aparado; caso contrário, dispensa.
- Apenas palavra de ativação ainda envia automaticamente após silêncio; push-to-talk envia imediatamente ao soltar.

## Implementado (9 de dezembro de 2025)

- As sessões do overlay agora carregam um token por captura (palavra de ativação ou push-to-talk). Atualizações de parcial/final/enviar/dispensar/nível são descartadas quando o token não corresponde, evitando callbacks obsoletos.
- Push-to-talk adota qualquer texto visível do overlay como prefixo (assim, pressionar a hotkey enquanto o overlay de palavra de ativação está ativo mantém o texto e acrescenta nova fala). Ele aguarda até 1,5s por uma transcrição final antes de recorrer ao texto atual.
- Logs de chime/overlay são emitidos em `info` nas categorias `voicewake.overlay`, `voicewake.ptt` e `voicewake.chime` (início de sessão, parcial, final, enviar, dispensar, motivo do chime).

## Próximos passos

1. **VoiceSessionCoordinator (actor)**
   - Possui exatamente um `VoiceSession` por vez.
   - API (baseada em token): `beginWakeCapture`, `beginPushToTalk`, `updatePartial`, `endCapture`, `cancel`, `applyCooldown`.
   - Descarta callbacks que carregam tokens obsoletos (impede que reconhecedores antigos reabram o overlay).
2. **VoiceSession (modelo)**
   - Campos: `token`, `source` (wakeWord|pushToTalk), texto comprometido/volátil, flags de chime, temporizadores (envio automático, inatividade), `overlayMode` (display|editing|sending), prazo de cooldown.
3. **Vinculação do overlay**
   - `VoiceSessionPublisher` (`ObservableObject`) espelha a sessão ativa no SwiftUI.
   - `VoiceWakeOverlayView` renderiza apenas via o publisher; nunca muta singletons globais diretamente.
   - Ações do usuário no overlay (`sendNow`, `dismiss`, `edit`) retornam ao coordinator com o token da sessão.
4. **Caminho unificado de envio**
   - Em `endCapture`: se o texto aparado estiver vazio → dispensar; caso contrário `performSend(session:)` (toca o chime de envio uma vez, encaminha, dispensa).
   - Push-to-talk: sem atraso; palavra de ativação: atraso opcional para envio automático.
   - Aplique um curto cooldown ao runtime de palavra de ativação após o término do push-to-talk para que a palavra de ativação não seja acionada imediatamente novamente.
5. **Logging**
   - O coordinator emite logs `.info` no subsistema `bot.molt`, categorias `voicewake.overlay` e `voicewake.chime`.
   - Eventos-chave: `session_started`, `adopted_by_push_to_talk`, `partial`, `finalized`, `send`, `dismiss`, `cancel`, `cooldown`.

## Checklist de depuração

- Transmita logs enquanto reproduz um overlay preso:

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- Verifique se há apenas um token de sessão ativo; callbacks obsoletos devem ser descartados pelo coordinator.

- Garanta que a liberação do push-to-talk sempre chame `endCapture` com o token ativo; se o texto estiver vazio, espere `dismiss` sem chime ou envio.

## Etapas de migração (sugeridas)

1. Adicione `VoiceSessionCoordinator`, `VoiceSession` e `VoiceSessionPublisher`.
2. Refatore `VoiceWakeRuntime` para criar/atualizar/encerrar sessões em vez de tocar `VoiceWakeOverlayController` diretamente.
3. Refatore `VoicePushToTalk` para adotar sessões existentes e chamar `endCapture` ao soltar; aplique cooldown em runtime.
4. Conecte `VoiceWakeOverlayController` ao publisher; remova chamadas diretas do runtime/PTT.
5. Adicione testes de integração para adoção de sessão, cooldown e dispensa de texto vazio.
