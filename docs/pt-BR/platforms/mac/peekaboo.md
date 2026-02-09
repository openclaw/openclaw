---
summary: "Integração do PeekabooBridge para automação de UI no macOS"
read_when:
  - Hospedando o PeekabooBridge no OpenClaw.app
  - Integrando o Peekaboo via Swift Package Manager
  - Alterando o protocolo/caminhos do PeekabooBridge
title: "Peekaboo Bridge"
---

# Peekaboo Bridge (automação de UI no macOS)

O OpenClaw pode hospedar o **PeekabooBridge** como um broker local de automação de UI, consciente de permissões. Isso permite que a CLI `peekaboo` conduza a automação de UI reutilizando as permissões TCC do app do macOS.

## O que é (e o que não é)

- **Host**: o OpenClaw.app pode atuar como um host do PeekabooBridge.
- **Cliente**: use a CLI `peekaboo` (sem uma superfície `openclaw ui ...` separada).
- **UI**: as sobreposições visuais permanecem no Peekaboo.app; o OpenClaw é um host broker enxuto.

## Ativar o bridge

No app do macOS:

- Ajustes → **Enable Peekaboo Bridge**

Quando ativado, o OpenClaw inicia um servidor local de socket UNIX. Se desativado, o host
é interrompido e `peekaboo` fará fallback para outros hosts disponíveis.

## Ordem de descoberta do cliente

Clientes do Peekaboo normalmente tentam os hosts nesta ordem:

1. Peekaboo.app (UX completa)
2. Claude.app (se instalado)
3. OpenClaw.app (broker enxuto)

Use `peekaboo bridge status --verbose` para ver qual host está ativo e qual
caminho de socket está em uso. Você pode substituir com:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## Segurança e permissões

- O bridge valida **assinaturas de código do chamador**; uma lista de permissões de TeamIDs é
  aplicada (TeamID do host Peekaboo + TeamID do app OpenClaw).
- As solicitações expiram após ~10 segundos.
- Se permissões obrigatórias estiverem ausentes, o bridge retorna uma mensagem de erro clara
  em vez de abrir os Ajustes do Sistema.

## Comportamento de snapshot (automação)

Snapshots são armazenados em memória e expiram automaticamente após um curto período.
Se você precisar de retenção mais longa, recapture a partir do cliente.

## Solução de problemas

- Se `peekaboo` reportar “bridge client is not authorized”, verifique se o cliente está
  devidamente assinado ou execute o host com `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`
  apenas no modo **debug**.
- Se nenhum host for encontrado, abra um dos apps host (Peekaboo.app ou OpenClaw.app)
  e confirme que as permissões foram concedidas.
