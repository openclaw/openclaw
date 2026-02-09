---
summary: "Palavras de ativação por voz globais (de propriedade do Gateway) e como elas são sincronizadas entre nós"
read_when:
  - Alterar o comportamento ou os padrões das palavras de ativação por voz
  - Adicionar novas plataformas de nós que precisam de sincronização de palavras de ativação
title: "Ativação por Voz"
---

# Ativação por Voz (Palavras de Ativação Globais)

O OpenClaw trata as **palavras de ativação como uma única lista global** pertencente ao **Gateway**.

- **Não existem palavras de ativação personalizadas por nó**.
- **Qualquer UI de nó/app pode editar** a lista; as alterações são persistidas pelo Gateway e transmitidas para todos.
- Cada dispositivo ainda mantém seu próprio alternador **Ativação por Voz ativada/desativada** (a UX local + permissões diferem).

## Armazenamento (host do Gateway)

As palavras de ativação são armazenadas na máquina do gateway em:

- `~/.openclaw/settings/voicewake.json`

Formato:

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## Protocolo

### Métodos

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set` com parâmetros `{ triggers: string[] }` → `{ triggers: string[] }`

Notas:

- Os gatilhos são normalizados (espaços aparados, vazios descartados). Listas vazias retornam aos padrões.
- Limites são aplicados por segurança (limites de quantidade/comprimento).

### Eventos

- `voicewake.changed` payload `{ triggers: string[] }`

Quem recebe:

- Todos os clientes WebSocket (app macOS, WebChat, etc.)
- Todos os nós conectados (iOS/Android), e também no momento da conexão do nó como um envio inicial do “estado atual”.

## Comportamento do cliente

### app macOS

- Usa a lista global para controlar gatilhos `VoiceWakeRuntime`.
- Editar “Palavras de gatilho” nas configurações de Ativação por Voz chama `voicewake.set` e então depende da transmissão para manter outros clientes em sincronia.

### nó iOS

- Usa a lista global para detecção de gatilhos `VoiceWakeManager`.
- Editar Palavras de Ativação em Configurações chama `voicewake.set` (via WS do Gateway) e também mantém a detecção local de palavras de ativação responsiva.

### nó Android

- Expõe um editor de Palavras de Ativação em Configurações.
- Chama `voicewake.set` via WS do Gateway para que as edições sejam sincronizadas em todos os lugares.
