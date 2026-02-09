---
summary: "Aplicativo complementar OpenClaw para macOS (barra de menus + corretor do gateway)"
read_when:
  - Implementando recursos do app macOS
  - Alterando o ciclo de vida do gateway ou a ponte de nós no macOS
title: "App macOS"
---

# OpenClaw macOS Companion (barra de menus + corretor do gateway)

O app macOS é o **companheiro da barra de menus** do OpenClaw. Ele controla permissões,
gerencia/conecta ao Gateway localmente (launchd ou manual) e expõe recursos do macOS
ao agente como um nó.

## O que ele faz

- Mostra notificações nativas e status na barra de menus.
- Controla prompts de TCC (Notificações, Acessibilidade, Gravação de Tela, Microfone,
  Reconhecimento de Fala, Automação/AppleScript).
- Executa ou conecta ao Gateway (local ou remoto).
- Expõe ferramentas exclusivas do macOS (Canvas, Câmera, Gravação de Tela, `system.run`).
- Inicia o serviço local de host de nó em modo **remoto** (launchd) e o interrompe em modo **local**.
- Opcionalmente hospeda o **PeekabooBridge** para automação de UI.
- Instala a CLI global (`openclaw`) via npm/pnpm sob demanda (bun não recomendado para o runtime do Gateway).

## Modo local vs remoto

- **Local** (padrão): o app se conecta a um Gateway local em execução, se existir;
  caso contrário, habilita o serviço launchd via `openclaw gateway install`.
- **Remoto**: o app se conecta a um Gateway via SSH/Tailscale e nunca inicia
  um processo local.
  O app inicia o **serviço de host de nó local** para que o Gateway remoto possa alcançar este Mac.
  O app não inicia o Gateway como processo filho.

## Controle do launchd

O app gerencia um LaunchAgent por usuário rotulado como `bot.molt.gateway`
(ou `bot.molt.<profile>` ao usar `--profile`/`OPENCLAW_PROFILE`; o legado `com.openclaw.*` ainda descarrega).

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Substitua o rótulo por `bot.molt.<profile>` ao executar um perfil nomeado.

Se o LaunchAgent não estiver instalado, habilite-o pelo app ou execute
`openclaw gateway install`.

## Capacidades do nó (mac)

O app macOS se apresenta como um nó. Comandos comuns:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Câmera: `camera.snap`, `camera.clip`
- Tela: `screen.record`
- Sistema: `system.run`, `system.notify`

O nó reporta um mapa `permissions` para que agentes decidam o que é permitido.

Serviço do nó + IPC do app:

- Quando o serviço headless de host de nó está em execução (modo remoto), ele se conecta ao Gateway WS como um nó.
- `system.run` executa no app macOS (contexto de UI/TCC) por meio de um socket Unix local; prompts e saídas permanecem no app.

Diagrama (SCI):

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## Aprovações de exec (system.run)

`system.run` é controlado por **Aprovações de Exec** no app macOS (Configurações → Aprovações de Exec).
Segurança + confirmação + lista de permissões são armazenadas localmente no Mac em:

```
~/.openclaw/exec-approvals.json
```

Exemplo:

```json
{
  "version": 1,
  "defaults": {
    "security": "deny",
    "ask": "on-miss"
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [{ "pattern": "/opt/homebrew/bin/rg" }]
    }
  }
}
```

Notas:

- Entradas `allowlist` são padrões glob para caminhos de binários resolvidos.
- Escolher “Sempre permitir” no prompt adiciona esse comando à lista de permissões.
- Substituições de ambiente `system.run` são filtradas (remove `PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`) e depois mescladas com o ambiente do app.

## Deep links

O app registra o esquema de URL `openclaw://` para ações locais.

### `openclaw://agent`

Dispara uma solicitação `agent` do Gateway.

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

Parâmetros de consulta:

- `message` (obrigatório)
- `sessionKey` (opcional)
- `thinking` (opcional)
- `deliver` / `to` / `channel` (opcional)
- `timeoutSeconds` (opcional)
- `key` (chave opcional de modo não assistido)

Segurança:

- Sem `key`, o app solicita confirmação.
- Com um `key` válido, a execução é não assistida (destinada a automações pessoais).

## Fluxo de onboarding (típico)

1. Instale e inicie **OpenClaw.app**.
2. Conclua a lista de permissões (prompts de TCC).
3. Garanta que o modo **Local** esteja ativo e que o Gateway esteja em execução.
4. Instale a CLI se voce quiser acesso pelo terminal.

## Build e fluxo de dev (nativo)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (ou Xcode)
- Empacotar o app: `scripts/package-mac-app.sh`

## Depurar conectividade do gateway (CLI macOS)

Use a CLI de depuração para exercitar o mesmo handshake de WebSocket do Gateway e a lógica
de descoberta que o app macOS usa, sem iniciar o app.

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

Opções de conexão:

- `--url <ws://host:port>`: substituir configuração
- `--mode <local|remote>`: resolver a partir da configuração (padrão: config ou local)
- `--probe`: forçar uma nova verificação de saúde
- `--timeout <ms>`: tempo limite da solicitação (padrão: `15000`)
- `--json`: saída estruturada para comparação

Opções de descoberta:

- `--include-local`: incluir gateways que seriam filtrados como “locais”
- `--timeout <ms>`: janela geral de descoberta (padrão: `2000`)
- `--json`: saída estruturada para comparação

Dica: compare com `openclaw gateway discover --json` para ver se o
pipeline de descoberta do app macOS (NWBrowser + fallback de DNS‑SD da tailnet) difere da descoberta baseada em `dns-sd` da Node CLI.

## Encaminhamento de conexão remota (túneis SSH)

Quando o app macOS é executado em modo **Remoto**, ele abre um túnel SSH para que componentes de UI locais
conversem com um Gateway remoto como se estivesse no localhost.

### Túnel de controle (porta WebSocket do Gateway)

- **Propósito:** verificações de saúde, status, Web Chat, configuração e outras chamadas do plano de controle.
- **Porta local:** a porta do Gateway (padrão `18789`), sempre estável.
- **Porta remota:** a mesma porta do Gateway no host remoto.
- **Comportamento:** sem porta local aleatória; o app reutiliza um túnel saudável existente
  ou o reinicia se necessário.
- **Formato SSH:** `ssh -N -L <local>:127.0.0.1:<remote>` com BatchMode +
  ExitOnForwardFailure + opções de keepalive.
- **Relato de IP:** o túnel SSH usa loopback, então o gateway verá o IP do nó como `127.0.0.1`. Use transporte **Direto (ws/wss)** se voce quiser que o IP real do cliente apareça (veja [acesso remoto no macOS](/platforms/mac/remote)).

Para etapas de configuração, veja [acesso remoto no macOS](/platforms/mac/remote). Para detalhes de protocolo,
veja [protocolo do Gateway](/gateway/protocol).

## Documentos relacionados

- [Runbook do Gateway](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [Permissões do macOS](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
