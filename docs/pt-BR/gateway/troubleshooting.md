---
summary: "Runbook de solução de problemas aprofundado para gateway, canais, automação, nós e navegador"
read_when:
  - O hub de solução de problemas apontou você para cá para um diagnóstico mais profundo
  - Você precisa de seções estáveis de runbook baseadas em sintomas com comandos exatos
title: "Solução de problemas"
---

# Solução de problemas do Gateway

Esta página é o runbook aprofundado.
Comece em [/help/troubleshooting](/help/troubleshooting) se você quiser primeiro o fluxo rápido de triagem.

## Escada de comandos

Execute estes primeiro, nesta ordem:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Sinais esperados de funcionamento saudável:

- `openclaw gateway status` mostra `Runtime: running` e `RPC probe: ok`.
- `openclaw doctor` relata nenhum problema de configuração/serviço bloqueante.
- `openclaw channels status --probe` mostra canais conectados/prontos.

## Sem respostas

Se os canais estiverem ativos, mas nada responder, verifique o roteamento e a política antes de reconectar qualquer coisa.

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

Procure por:

- Pareamento pendente para remetentes de DM.
- Restrição por menção em grupo (`requireMention`, `mentionPatterns`).
- Incompatibilidades na lista de permissões de canal/grupo.

Assinaturas comuns:

- `drop guild message (mention required` → mensagem de grupo ignorada até menção.
- `pairing request` → o remetente precisa de aprovação.
- `blocked` / `allowlist` → remetente/canal foi filtrado pela política.

Relacionado:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## Conectividade da UI de controle do dashboard

Quando a UI de controle do dashboard não conecta, valide a URL, o modo de autenticação e as suposições de contexto seguro.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

Procure por:

- URL de probe correta e URL do dashboard.
- Incompatibilidade de modo/token de autenticação entre cliente e gateway.
- Uso de HTTP onde a identidade do dispositivo é exigida.

Assinaturas comuns:

- `device identity required` → contexto não seguro ou autenticação de dispositivo ausente.
- `unauthorized` / loop de reconexão → incompatibilidade de token/senha.
- `gateway connect failed:` → host/porta/URL de destino incorretos.

Relacionado:

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## Serviço do Gateway não está em execução

Use isto quando o serviço está instalado, mas o processo não se mantém ativo.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

Procure por:

- `Runtime: stopped` com dicas de saída.
- Incompatibilidade de configuração do serviço (`Config (cli)` vs `Config (service)`).
- Conflitos de porta/listener.

Assinaturas comuns:

- `Gateway start blocked: set gateway.mode=local` → o modo de gateway local não está habilitado.
- `refusing to bind gateway ... without auth` → bind fora do loopback sem token/senha.
- `another gateway instance is already listening` / `EADDRINUSE` → conflito de porta.

Relacionado:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## Canal conectado, mensagens não fluem

Se o estado do canal está conectado, mas o fluxo de mensagens morreu, foque em política, permissões e regras específicas de entrega do canal.

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

Procure por:

- Política de DM (`pairing`, `allowlist`, `open`, `disabled`).
- Lista de permissões de grupo e requisitos de menção.
- Permissões/escopos de API do canal ausentes.

Assinaturas comuns:

- `mention required` → mensagem ignorada pela política de menção em grupo.
- `pairing` / rastros de aprovação pendente → o remetente não está aprovado.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → problema de autenticação/permissões do canal.

Relacionado:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Entrega de cron e heartbeat

Se o cron ou o heartbeat não executou ou não entregou, verifique primeiro o estado do agendador e depois o destino de entrega.

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

Procure por:

- Cron habilitado e próxima ativação presente.
- Status do histórico de execução do job (`ok`, `skipped`, `error`).
- Motivos de pulo do heartbeat (`quiet-hours`, `requests-in-flight`, `alerts-disabled`).

Assinaturas comuns:

- `cron: scheduler disabled; jobs will not run automatically` → cron desabilitado.
- `cron: timer tick failed` → tick do agendador falhou; verifique erros de arquivo/log/runtime.
- `heartbeat skipped` com `reason=quiet-hours` → fora da janela de horas ativas.
- `heartbeat: unknown accountId` → id de conta inválido para o destino de entrega do heartbeat.

Relacionado:

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## Ferramenta emparelhada de nó falhou

Se um nó está pareado, mas as ferramentas falham, isole estado de primeiro plano, permissões e aprovação.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

Procure por:

- Nó online com as capacidades esperadas.
- Concessões de permissão do SO para câmera/microfone/localização/tela.
- Aprovações de exec e estado da lista de permissões.

Assinaturas comuns:

- `NODE_BACKGROUND_UNAVAILABLE` → o app do nó deve estar em primeiro plano.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → permissão do SO ausente.
- `SYSTEM_RUN_DENIED: approval required` → aprovação de exec pendente.
- `SYSTEM_RUN_DENIED: allowlist miss` → comando bloqueado pela lista de permissões.

Relacionado:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## Falha da ferramenta de navegador

Use isto quando ações da ferramenta de navegador falham mesmo que o gateway em si esteja saudável.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

Procure por:

- Caminho válido do executável do navegador.
- Acessibilidade do perfil CDP.
- Anexação da aba de relay da extensão para `profile="chrome"`.

Assinaturas comuns:

- `Failed to start Chrome CDP on port` → o processo do navegador falhou ao iniciar.
- `browser.executablePath not found` → o caminho configurado é inválido.
- `Chrome extension relay is running, but no tab is connected` → relay da extensão não anexado.
- `Browser attachOnly is enabled ... not reachable` → perfil apenas de anexação não tem alvo acessível.

Relacionado:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## Se você atualizou e algo quebrou de repente

A maioria das quebras pós-atualização é desvio de configuração ou padrões mais rígidos agora sendo aplicados.

### 1. O comportamento de autenticação e sobrescrita de URL mudou

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

O que verificar:

- Se `gateway.mode=remote`, chamadas da CLI podem estar apontando para remoto enquanto seu serviço local está ok.
- Chamadas explícitas de `--url` não fazem fallback para credenciais armazenadas.

Assinaturas comuns:

- `gateway connect failed:` → URL de destino incorreta.
- `unauthorized` → endpoint alcançável, mas autenticação errada.

### 2. Guardrails de bind e autenticação estão mais rígidos

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

O que verificar:

- Binds fora do loopback (`lan`, `tailnet`, `custom`) precisam de autenticação configurada.
- Chaves antigas como `gateway.token` não substituem `gateway.auth.token`.

Assinaturas comuns:

- `refusing to bind gateway ... without auth` → incompatibilidade entre bind e autenticação.
- `RPC probe: failed` enquanto o runtime está em execução → gateway ativo, mas inacessível com a autenticação/URL atuais.

### 3. O estado de pareamento e identidade do dispositivo mudou

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

O que verificar:

- Aprovações de dispositivo pendentes para dashboard/nós.
- Aprovações de pareamento de DM pendentes após mudanças de política ou identidade.

Assinaturas comuns:

- `device identity required` → autenticação do dispositivo não satisfeita.
- `pairing required` → remetente/dispositivo deve ser aprovado.

Se a configuração do serviço e o runtime ainda discordarem após as verificações, reinstale os metadados do serviço a partir do mesmo diretório de perfil/estado:

```bash
openclaw gateway install --force
openclaw gateway restart
```

Relacionado:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
