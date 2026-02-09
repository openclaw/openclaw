---
summary: "Arquitetura de IPC do macOS para o app OpenClaw, transporte de nó do gateway e PeekabooBridge"
read_when:
  - Editando contratos de IPC ou IPC do app da barra de menus
title: "IPC do macOS"
---

# Arquitetura de IPC do OpenClaw no macOS

**Modelo atual:** um socket Unix local conecta o **serviço host do nó** ao **app do macOS** para aprovações de exec + `system.run`. Existe uma CLI de debug `openclaw-mac` para verificações de descoberta/conexão; as ações do agente ainda fluem pelo WebSocket do Gateway e `node.invoke`. A automação de UI usa o PeekabooBridge.

## Objetivos

- Uma única instância de app GUI que possui todo o trabalho voltado ao TCC (notificações, gravação de tela, microfone, fala, AppleScript).
- Uma superfície pequena para automação: Gateway + comandos de nó, além do PeekabooBridge para automação de UI.
- Permissões previsíveis: sempre o mesmo bundle ID assinado, iniciado pelo launchd, para que as concessões do TCC persistam.

## Como funciona

### Gateway + transporte de nó

- O app executa o Gateway (modo local) e se conecta a ele como um nó.
- As ações do agente são executadas via `node.invoke` (por exemplo, `system.run`, `system.notify`, `canvas.*`).

### Serviço de nó + IPC do app

- Um serviço host de nó headless conecta-se ao WebSocket do Gateway.
- Requisições `system.run` são encaminhadas ao app do macOS por um socket Unix local.
- O app executa o exec no contexto de UI, solicita confirmação se necessário e retorna a saída.

Diagrama (SCI):

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge (automação de UI)

- A automação de UI usa um socket UNIX separado chamado `bridge.sock` e o protocolo JSON do PeekabooBridge.
- Ordem de preferência de host (lado do cliente): Peekaboo.app → Claude.app → OpenClaw.app → execução local.
- Segurança: hosts do bridge exigem um TeamID permitido; uma rota de escape DEBUG-only com mesmo UID é protegida por `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (convenção do Peekaboo).
- Veja: [uso do PeekabooBridge](/platforms/mac/peekaboo) para detalhes.

## Fluxos operacionais

- Reiniciar/recompilar: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - Encerra instâncias existentes
  - Build Swift + empacotamento
  - Grava/bootstrap/kickstart do LaunchAgent
- Instância única: o app encerra cedo se outra instância com o mesmo bundle ID estiver em execução.

## Notas de endurecimento

- Prefira exigir correspondência de TeamID para todas as superfícies privilegiadas.
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (DEBUG-only) pode permitir chamadores com o mesmo UID para desenvolvimento local.
- Toda a comunicação permanece apenas local; nenhum socket de rede é exposto.
- Os prompts do TCC se originam apenas do bundle do app GUI; mantenha o bundle ID assinado estável entre recompilações.
- Endurecimento de IPC: modo do socket `0600`, token, verificações de UID do par, desafio/resposta HMAC, TTL curto.
