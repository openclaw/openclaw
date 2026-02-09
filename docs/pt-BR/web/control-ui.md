---
summary: "UI de controle baseada em navegador para o Gateway (chat, nós, configuração)"
read_when:
  - Você quer operar o Gateway a partir de um navegador
  - Você quer acesso via Tailnet sem túneis SSH
title: "UI de Controle"
---

# UI de Controle (navegador)

A UI de Controle é um pequeno app de página única **Vite + Lit** servido pelo Gateway:

- padrão: `http://<host>:18789/`
- prefixo opcional: defina `gateway.controlUi.basePath` (ex.: `/openclaw`)

Ela se comunica **diretamente com o WebSocket do Gateway** na mesma porta.

## Abertura rápida (local)

Se o Gateway estiver em execução no mesmo computador, abra:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (ou [http://localhost:18789/](http://localhost:18789/))

Se a página não carregar, inicie o Gateway primeiro: `openclaw gateway`.

A autenticação é fornecida durante o handshake do WebSocket via:

- `connect.params.auth.token`
- `connect.params.auth.password`
  O painel de configurações do dashboard permite armazenar um token; senhas não são persistidas.
  O assistente de onboarding gera um token do gateway por padrão, então cole-o aqui na primeira conexão.

## Pareamento de dispositivo (primeira conexão)

Quando você se conecta à UI de Controle a partir de um novo navegador ou dispositivo, o Gateway
exige uma **aprovação de pareamento única** — mesmo se você estiver na mesma Tailnet
com `gateway.auth.allowTailscale: true`. Isso é uma medida de segurança para evitar
acesso não autorizado.

**O que você verá:** "disconnected (1008): pairing required"

**Para aprovar o dispositivo:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

Após a aprovação, o dispositivo é lembrado e não exigirá nova aprovação, a menos
que você o revogue com `openclaw devices revoke --device <id> --role <role>`. Veja
[Devices CLI](/cli/devices) para rotação e revogação de tokens.

**Notas:**

- Conexões locais (`127.0.0.1`) são aprovadas automaticamente.
- Conexões remotas (LAN, Tailnet, etc.) exigem aprovação explícita.
- Cada perfil de navegador gera um ID de dispositivo único; portanto, trocar de navegador ou
  limpar os dados do navegador exigirá novo pareamento.

## O que ela pode fazer (hoje)

- Conversar com o modelo via Gateway WS (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- Fazer streaming de chamadas de ferramentas + cartões de saída de ferramentas ao vivo no Chat (eventos do agente)
- Canais: status do WhatsApp/Telegram/Discord/Slack + canais de plugin (Mattermost, etc.) + login por QR + configuração por canal (`channels.status`, `web.login.*`, `config.patch`)
- Instâncias: lista de presença + atualização (`system-presence`)
- Sessões: lista + substituições de thinking/verbose por sessão (`sessions.list`, `sessions.patch`)
- Cron jobs: listar/adicionar/executar/habilitar/desabilitar + histórico de execuções (`cron.*`)
- Skills: status, habilitar/desabilitar, instalar, atualizações de chave de API (`skills.*`)
- Nós: lista + capacidades (`node.list`)
- Aprovações de exec: editar allowlists do gateway ou do nó + política de solicitação para `exec host=gateway/node` (`exec.approvals.*`)
- Configuração: visualizar/editar `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- Configuração: aplicar + reiniciar com validação (`config.apply`) e acordar a última sessão ativa
- Gravações de configuração incluem um guard de hash base para evitar sobrescrever edições concorrentes
- Esquema de configuração + renderização de formulários (`config.schema`, incluindo esquemas de plugin + canal); o editor Raw JSON permanece disponível
- Debug: snapshots de status/saúde/modelos + log de eventos + chamadas RPC manuais (`status`, `health`, `models.list`)
- Logs: tail ao vivo dos logs de arquivo do gateway com filtro/exportação (`logs.tail`)
- Atualização: executar uma atualização de pacote/git + reiniciar (`update.run`) com um relatório de reinicialização

Notas do painel de Cron jobs:

- Para jobs isolados, a entrega padrão é anunciar um resumo. Você pode alternar para nenhum se quiser execuções apenas internas.
- Os campos de canal/alvo aparecem quando anunciar é selecionado.

## Comportamento do chat

- `chat.send` é **não bloqueante**: confirma imediatamente com `{ runId, status: "started" }` e a resposta é transmitida via eventos `chat`.
- Reenviar com o mesmo `idempotencyKey` retorna `{ status: "in_flight" }` enquanto estiver em execução, e `{ status: "ok" }` após a conclusão.
- `chat.inject` adiciona uma nota do assistente ao transcript da sessão e transmite um evento `chat` apenas para atualizações de UI (sem execução do agente, sem entrega em canal).
- Stop:
  - Clique em **Stop** (chama `chat.abort`)
  - Digite `/stop` (ou `stop|esc|abort|wait|exit|interrupt`) para abortar fora de banda
  - `chat.abort` oferece suporte a `{ sessionKey }` (sem `runId`) para abortar todas as execuções ativas daquela sessão

## Acesso via Tailnet (recomendado)

### Tailscale Serve integrado (preferido)

Mantenha o Gateway em loopback e deixe o Tailscale Serve fazer o proxy com HTTPS:

```bash
openclaw gateway --tailscale serve
```

Abra:

- `https://<magicdns>/` (ou seu `gateway.controlUi.basePath` configurado)

Por padrão, as requisições do Serve podem se autenticar via cabeçalhos de identidade do Tailscale
(`tailscale-user-login`) quando `gateway.auth.allowTailscale` está `true`. O OpenClaw
verifica a identidade resolvendo o endereço `x-forwarded-for` com
`tailscale whois` e comparando com o cabeçalho, e só aceita isso quando a
requisição atinge o loopback com os cabeçalhos `x-forwarded-*` do Tailscale. Defina
`gateway.auth.allowTailscale: false` (ou force `gateway.auth.mode: "password"`)
se você quiser exigir token/senha mesmo para tráfego do Serve.

### Vincular à tailnet + token

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

Depois abra:

- `http://<tailscale-ip>:18789/` (ou seu `gateway.controlUi.basePath` configurado)

Cole o token nas configurações da UI (enviado como `connect.params.auth.token`).

## HTTP inseguro

Se você abrir o dashboard via HTTP simples (`http://<lan-ip>` ou `http://<tailscale-ip>`),
o navegador roda em um **contexto não seguro** e bloqueia o WebCrypto. Por padrão,
o OpenClaw **bloqueia** conexões da UI de Controle sem identidade do dispositivo.

**Correção recomendada:** use HTTPS (Tailscale Serve) ou abra a UI localmente:

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (no host do gateway)

**Exemplo de downgrade (apenas token via HTTP):**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

Isso desativa identidade do dispositivo + pareamento para a UI de Controle (mesmo em HTTPS). Use
apenas se você confiar na rede.

Veja [Tailscale](/gateway/tailscale) para orientações de configuração de HTTPS.

## Construindo a UI

O Gateway serve arquivos estáticos a partir de `dist/control-ui`. Compile-os com:

```bash
pnpm ui:build # auto-installs UI deps on first run
```

Base absoluta opcional (quando você quer URLs de assets fixas):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

Para desenvolvimento local (servidor de dev separado):

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

Depois, aponte a UI para a URL do WS do seu Gateway (ex.: `ws://127.0.0.1:18789`).

## Depuração/testes: servidor de dev + Gateway remoto

A UI de Controle é composta por arquivos estáticos; o destino do WebSocket é configurável e pode ser
diferente da origem HTTP. Isso é útil quando você quer o servidor de dev do Vite localmente,
mas o Gateway roda em outro lugar.

1. Inicie o servidor de dev da UI: `pnpm ui:dev`
2. Abra uma URL como:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

Autenticação opcional única (se necessário):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

Notas:

- `gatewayUrl` é armazenado no localStorage após o carregamento e removido da URL.
- `token` é armazenado no localStorage; `password` é mantido apenas na memória.
- Quando `gatewayUrl` está definido, a UI não faz fallback para credenciais de configuração ou de ambiente.
  Forneça `token` (ou `password`) explicitamente. A ausência de credenciais explícitas é um erro.
- Use `wss://` quando o Gateway estiver atrás de TLS (Tailscale Serve, proxy HTTPS, etc.).
- `gatewayUrl` só é aceito em uma janela de nível superior (não incorporada) para evitar clickjacking.
- Para configurações de dev com cross-origin (ex.: `pnpm ui:dev` para um Gateway remoto), adicione a origem da UI a `gateway.controlUi.allowedOrigins`.

Exemplo:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

Detalhes de configuração de acesso remoto: [Acesso remoto](/gateway/remote).
