---
summary: "Modos de ativação por voz e push-to-talk, além de detalhes de roteamento no app para mac"
read_when:
  - Trabalhando nos fluxos de ativação por voz ou PTT
title: "Ativação por Voz"
---

# Ativação por Voz & Push-to-Talk

## Modos

- **Modo de palavra de ativação** (padrão): o reconhecedor de fala sempre ativo aguarda tokens de disparo (`swabbleTriggerWords`). Ao corresponder, inicia a captura, mostra a sobreposição com texto parcial e envia automaticamente após silêncio.
- **Push-to-talk (segurar Option direita)**: segure a tecla Option direita para capturar imediatamente — sem gatilho. A sobreposição aparece enquanto estiver pressionada; ao soltar, finaliza e encaminha após um curto atraso para que você possa ajustar o texto.

## Comportamento em tempo de execução (palavra de ativação)

- O reconhecedor de fala vive em `VoiceWakeRuntime`.
- O gatilho só dispara quando há uma **pausa significativa** entre a palavra de ativação e a próxima palavra (~0,55s de intervalo). A sobreposição/som pode começar na pausa, mesmo antes do comando iniciar.
- Janelas de silêncio: 2,0s quando a fala está fluindo, 5,0s se apenas o gatilho foi ouvido.
- Parada rígida: 120s para evitar sessões fora de controle.
- Debounce entre sessões: 350ms.
- A sobreposição é dirigida via `VoiceWakeOverlayController` com coloração de texto confirmado/volátil.
- Após o envio, o reconhecedor reinicia de forma limpa para ouvir o próximo gatilho.

## Invariantes do ciclo de vida

- Se a Ativação por Voz estiver habilitada e as permissões concedidas, o reconhecedor da palavra de ativação deve estar escutando (exceto durante uma captura explícita de push-to-talk).
- A visibilidade da sobreposição (incluindo o fechamento manual pelo botão X) nunca deve impedir que o reconhecedor retome.

## Modo de falha da sobreposição “grudada” (anterior)

Antes, se a sobreposição ficasse visível e você a fechasse manualmente, a Ativação por Voz podia parecer “morta” porque a tentativa de reinício do runtime podia ser bloqueada pela visibilidade da sobreposição e nenhum reinício subsequente era agendado.

Endurecimento:

- O reinício do runtime de ativação não é mais bloqueado pela visibilidade da sobreposição.
- A conclusão do fechamento da sobreposição dispara um `VoiceWakeRuntime.refresh(...)` via `VoiceSessionCoordinator`, para que o X manual sempre retome a escuta.

## Especificidades do push-to-talk

- A detecção de atalho usa um monitor global `.flagsChanged` para **Option direita** (`keyCode 61` + `.option`). Apenas observamos eventos (sem engolir).
- O pipeline de captura vive em `VoicePushToTalk`: inicia o reconhecimento imediatamente, transmite parciais para a sobreposição e chama `VoiceWakeForwarder` ao soltar.
- Quando o push-to-talk começa, pausamos o runtime de palavra de ativação para evitar taps de áudio concorrentes; ele reinicia automaticamente após a liberação.
- Permissões: requer Microfone + Fala; para ver eventos é necessária aprovação de Acessibilidade/Monitoramento de Entrada.
- Teclados externos: alguns podem não expor a Option direita como esperado — ofereça um atalho alternativo se os usuários relatarem falhas.

## Configurações voltadas ao usuário

- Alternância **Ativação por Voz**: habilita o runtime de palavra de ativação.
- **Segurar Cmd+Fn para falar**: habilita o monitor de push-to-talk. Desativado no macOS < 26.
- Seletores de idioma e microfone, medidor de nível ao vivo, tabela de palavras de gatilho, testador (apenas local; não encaminha).
- O seletor de microfone preserva a última seleção se um dispositivo se desconectar, mostra um aviso de desconexão e recorre temporariamente ao padrão do sistema até ele retornar.
- **Sons**: toques ao detectar o gatilho e ao enviar; padrão é o som de sistema “Glass” do macOS. Você pode escolher qualquer arquivo carregável por `NSSound` (por exemplo, MP3/WAV/AIFF) para cada evento ou escolher **Sem Som**.

## Comportamento de encaminhamento

- Quando a Ativação por Voz está habilitada, as transcrições são encaminhadas ao gateway/agente ativo (o mesmo modo local vs remoto usado pelo restante do app para mac).
- As respostas são entregues ao **provedor principal usado por último** (WhatsApp/Telegram/Discord/WebChat). Se a entrega falhar, o erro é registrado e a execução ainda fica visível via WebChat/logs de sessão.

## Payload de encaminhamento

- `VoiceWakeForwarder.prefixedTranscript(_:)` antepõe a dica da máquina antes do envio. Compartilhado entre os caminhos de palavra de ativação e push-to-talk.

## Verificação rápida

- Ative o push-to-talk, segure Cmd+Fn, fale, solte: a sobreposição deve mostrar parciais e então enviar.
- Enquanto segura, as orelhas da barra de menus devem permanecer ampliadas (usa `triggerVoiceEars(ttl:nil)`); elas diminuem após soltar.
