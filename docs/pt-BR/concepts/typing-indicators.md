---
summary: "Quando o OpenClaw mostra indicadores de digitação e como ajustá-los"
read_when:
  - Alterando o comportamento ou os padrões do indicador de digitação
title: "Indicadores de digitação"
---

# Indicadores de digitação

Indicadores de digitação são enviados para o canal de chat enquanto uma execução está ativa. Use
`agents.defaults.typingMode` para controlar **quando** a digitação começa e `typingIntervalSeconds`
para controlar **com que frequência** ela é atualizada.

## Padrões

Quando `agents.defaults.typingMode` está **não definido**, o OpenClaw mantém o comportamento legado:

- **Conversas diretas**: a digitação começa imediatamente quando o loop do modelo inicia.
- **Conversas em grupo com uma menção**: a digitação começa imediatamente.
- **Conversas em grupo sem uma menção**: a digitação começa apenas quando o texto da mensagem começa a ser transmitido.
- **Execuções de heartbeat**: a digitação é desativada.

## Modos

Defina `agents.defaults.typingMode` como um dos seguintes:

- `never` — nenhum indicador de digitação, nunca.
- `instant` — começa a digitar **assim que o loop do modelo inicia**, mesmo que a execução
  posteriormente retorne apenas o token de resposta silenciosa.
- `thinking` — começa a digitar no **primeiro delta de raciocínio** (requer
  `reasoningLevel: "stream"` para a execução).
- `message` — começa a digitar no **primeiro delta de texto não silencioso** (ignora
  o token silencioso `NO_REPLY`).

Ordem de “quão cedo é acionado”:
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

Você pode sobrescrever o modo ou a cadência por sessão:

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## Notas

- O modo `message` não mostrará digitação para respostas apenas silenciosas (por exemplo, o token `NO_REPLY`
  usado para suprimir a saída).
- `thinking` só é acionado se a execução transmitir raciocínio (`reasoningLevel: "stream"`).
  Se o modelo não emitir deltas de raciocínio, a digitação não começará.
- Heartbeats nunca mostram digitação, independentemente do modo.
- `typingIntervalSeconds` controla a **cadência de atualização**, não o momento de início.
  O padrão é 6 segundos.
