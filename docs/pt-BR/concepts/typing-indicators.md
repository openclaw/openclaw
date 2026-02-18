---
summary: "Quando OpenClaw mostra indicadores de digitação e como ajustá-los"
read_when:
  - Alterando comportamento ou padrões de indicadores de digitação
title: "Indicadores de Digitação"
---

# Indicadores de digitação

Indicadores de digitação são enviados para o canal de chat enquanto uma execução está ativa. Use `agents.defaults.typingMode` para controlar **quando** a digitação começa e `typingIntervalSeconds` para controlar **com que frequência** ela se atualiza.

## Padrões

Quando `agents.defaults.typingMode` **não é definido**, OpenClaw mantém o comportamento legado:

- **Chats diretos**: digitação começa imediatamente assim que o loop do modelo começa.
- **Chats em grupo com uma menção**: digitação começa imediatamente.
- **Chats em grupo sem uma menção**: digitação começa apenas quando o texto da mensagem começa a fazer streaming.
- **Execuções de heartbeat**: digitação é desativada.

## Modos

Defina `agents.defaults.typingMode` para um dos:

- `never` — nenhum indicador de digitação, nunca.
- `instant` — comece a digitação **assim que o loop do modelo começa**, mesmo que a execução posteriormente retorne apenas o token de resposta silenciosa.
- `thinking` — comece a digitação no **primeiro delta de raciocínio** (requer `reasoningLevel: "stream"` para a execução).
- `message` — comece a digitação no **primeiro delta de texto não-silencioso** (ignora o token silencioso `NO_REPLY`).

Ordem de "quão cedo dispara":
`never` → `message` → `thinking` → `instant`

## Configuração

```json5
{
  agent: {
    typingMode: "thinking",
    typingIntervalSeconds: 6,
  },
}
```

Você pode sobrescrever modo ou cadência por sessão:

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## Notas

- O modo `message` não mostrará digitação para respostas apenas-silenciosas (ex. o token `NO_REPLY` usado para suprimir saída).
- `thinking` apenas dispara se a execução faz streaming de raciocínio (`reasoningLevel: "stream"`). Se o modelo não emitir deltas de raciocínio, a digitação não começará.
- Heartbeats nunca mostram digitação, independentemente do modo.
- `typingIntervalSeconds` controla a **cadência de atualização**, não o tempo de início. O padrão é 6 segundos.
