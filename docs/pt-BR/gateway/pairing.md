---
summary: "Pareamento de nós de propriedade do Gateway (Opção B) para iOS e outros nós remotos"
read_when:
  - Implementando aprovações de pareamento de nós sem UI do macOS
  - Adicionando fluxos de CLI para aprovar nós remotos
  - Estendendo o protocolo do gateway com gerenciamento de nós
title: "Pareamento Gateway-Owned"
---

# Pareamento de propriedade do Gateway (Opção B)

No pareamento de propriedade do Gateway, o **Gateway** é a fonte de verdade sobre quais nós
têm permissão para entrar. UIs (app do macOS, clientes futuros) são apenas frontends que
aprovam ou rejeitam solicitações pendentes.

**Importante:** nós WS usam **pareamento de dispositivo** (papel `node`) durante `connect`.
`node.pair.*` é um armazenamento de pareamento separado e **não** controla o handshake WS.
Apenas clientes que chamam explicitamente `node.pair.*` usam este fluxo.

## Conceitos

- **Solicitação pendente**: um nó solicitou entrada; requer aprovação.
- **Nó pareado**: nó aprovado com um token de autenticação emitido.
- **Transporte**: o endpoint WS do Gateway encaminha solicitações, mas não decide
  a associação. (O suporte legado à ponte TCP está obsoleto/removido.) (Suporte à ponte TCP legada está obsoleto/removido)

## Como o pareamento funciona

1. Um nó se conecta ao WS do Gateway e solicita pareamento.
2. O Gateway armazena uma **solicitação pendente** e emite `node.pair.requested`.
3. Voce aprova ou rejeita a solicitação (CLI ou UI).
4. Na aprovação, o Gateway emite um **novo token** (tokens são rotacionados em novo pareamento).
5. O nó se reconecta usando o token e agora está “pareado”.

Solicitações pendentes expiram automaticamente após **5 minutos**.

## Fluxo de trabalho da CLI (amigável para headless)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` mostra nós pareados/conectados e suas capacidades.

## Superfície da API (protocolo do gateway)

Eventos:

- `node.pair.requested` — emitido quando uma nova solicitação pendente é criada.
- `node.pair.resolved` — emitido quando uma solicitação é aprovada/rejeitada/expirada.

Métodos:

- `node.pair.request` — cria ou reutiliza uma solicitação pendente.
- `node.pair.list` — lista nós pendentes + pareados.
- `node.pair.approve` — aprova uma solicitação pendente (emite token).
- `node.pair.reject` — rejeita uma solicitação pendente.
- `node.pair.verify` — verifica `{ nodeId, token }`.

Notas:

- `node.pair.request` é idempotente por nó: chamadas repetidas retornam a mesma
  solicitação pendente.
- A aprovação **sempre** gera um token novo; nenhum token é retornado de
  `node.pair.request`.
- As solicitações podem incluir `silent: true` como uma dica para fluxos de aprovação automática.

## Aprovação automática (app do macOS)

O app do macOS pode opcionalmente tentar uma **aprovação silenciosa** quando:

- a solicitação está marcada como `silent`, e
- o app consegue verificar uma conexão SSH com o host do Gateway usando o mesmo usuário.

Se a aprovação silenciosa falhar, ele volta ao prompt normal de “Aprovar/Rejeitar”.

## Armazenamento (local, privado)

O estado de pareamento é armazenado no diretório de estado do Gateway (padrão `~/.openclaw`):

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

Se voce substituir `OPENCLAW_STATE_DIR`, a pasta `nodes/` é movida junto com ele.

Notas de segurança:

- Tokens são segredos; trate `paired.json` como sensível.
- Rotacionar um token exige nova aprovação (ou a exclusão da entrada do nó).

## Comportamento do transporte

- O transporte é **sem estado**; ele não armazena associação.
- Se o Gateway estiver offline ou o pareamento estiver desativado, os nós não conseguem parear.
- Se o Gateway estiver em modo remoto, o pareamento ainda ocorre contra o armazenamento do Gateway remoto.
