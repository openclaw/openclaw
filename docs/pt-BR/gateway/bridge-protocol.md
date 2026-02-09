---
summary: "Protocolo de bridge (nós legados): TCP JSONL, pareamento, RPC com escopo"
read_when:
  - Criando ou depurando clientes de nó (modo nó iOS/Android/macOS)
  - Investigando falhas de pareamento ou autenticação da bridge
  - Auditando a superfície de nó exposta pelo gateway
title: "Protocolo de Bridge"
---

# Protocolo de bridge (transporte de nó legado)

O protocolo Bridge é um transporte de nó **legado** (TCP JSONL). Novos clientes de nó
devem usar o protocolo WebSocket unificado do Gateway em vez disso.

Se você está criando um operador ou cliente de nó, use o
[protocolo do Gateway](/gateway/protocol).

**Nota:** As builds atuais do OpenClaw não incluem mais o listener de bridge TCP; este documento é mantido para referência histórica.
As chaves de configuração legadas `bridge.*` não fazem mais parte do esquema de configuração.

## Por que temos ambos

- **Limite de segurança**: a bridge expõe uma pequena lista de permissões em vez de
  toda a superfície da API do gateway.
- **Pareamento + identidade do nó**: a admissão de nós é controlada pelo gateway e vinculada
  a um token por nó.
- **UX de descoberta**: nós podem descobrir gateways via Bonjour na LAN ou conectar-se
  diretamente por um tailnet.
- **WS em loopback**: o plano de controle WS completo permanece local, a menos que seja tunelado via SSH.

## Transporte

- TCP, um objeto JSON por linha (JSONL).
- TLS opcional (quando `bridge.tls.enabled` é true).
- A porta padrão legada do listener era `18790` (as builds atuais não iniciam uma bridge TCP).

Quando o TLS está habilitado, os registros TXT de descoberta incluem `bridgeTls=1` além de
`bridgeTlsSha256` para que os nós possam fixar o certificado.

## Handshake + pareamento

1. O cliente envia `hello` com metadados do nó + token (se já estiver pareado).
2. Se não estiver pareado, o gateway responde `error` (`NOT_PAIRED`/`UNAUTHORIZED`).
3. O cliente envia `pair-request`.
4. O gateway aguarda aprovação e, em seguida, envia `pair-ok` e `hello-ok`.

`hello-ok` retorna `serverName` e pode incluir `canvasHostUrl`.

## Frames

Cliente → Gateway:

- `req` / `res`: RPC do gateway com escopo (chat, sessões, configuração, saúde, voicewake, skills.bins)
- `event`: sinais do nó (transcrição de voz, solicitação de agente, inscrição em chat, ciclo de vida de exec)

Gateway → Cliente:

- `invoke` / `invoke-res`: comandos do nó (`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event`: atualizações de chat para sessões inscritas
- `ping` / `pong`: keepalive

A aplicação da lista de permissões legada ficava em `src/gateway/server-bridge.ts` (removido).

## Eventos do ciclo de vida de exec

Os nós podem emitir eventos `exec.finished` ou `exec.denied` para expor a atividade de system.run.
Eles são mapeados para eventos de sistema no gateway. (Nós legados ainda podem emitir `exec.started`.)

Campos do payload (todos opcionais, salvo indicação):

- `sessionKey` (obrigatório): sessão do agente para receber o evento de sistema.
- `runId`: id único de exec para agrupamento.
- `command`: string de comando bruta ou formatada.
- `exitCode`, `timedOut`, `success`, `output`: detalhes de conclusão (apenas finalizado).
- `reason`: motivo da negação (apenas negado).

## Uso de tailnet

- Vincule a bridge a um IP de tailnet: `bridge.bind: "tailnet"` em
  `~/.openclaw/openclaw.json`.
- Os clientes se conectam via nome MagicDNS ou IP do tailnet.
- O Bonjour **não** cruza redes; use host/porta manual ou DNS‑SD de área ampla
  quando necessário.

## Versionamento

A bridge é atualmente **v1 implícita** (sem negociação de min/max). Espera-se compatibilidade retroativa; adicione um campo de versão do protocolo da bridge antes de qualquer mudança incompatível.
