---
summary: "Serviço integrado de controle do navegador + comandos de ação"
read_when:
  - Adicionar automação de navegador controlada por agente
  - Depurar por que o openclaw está interferindo no seu próprio Chrome
  - Implementar configurações e ciclo de vida do navegador no app macOS
title: "Browser (gerenciado pelo OpenClaw)"
---

# Browser (gerenciado pelo openclaw)

O OpenClaw pode executar um **perfil dedicado do Chrome/Brave/Edge/Chromium** que o agente controla.
Ele é isolado do seu navegador pessoal e é gerenciado por meio de um pequeno
serviço de controle local dentro do Gateway (apenas loopback).

Visão para iniciantes:

- Pense nisso como um **navegador separado, apenas para o agente**.
- O perfil `openclaw` **não** toca no perfil do seu navegador pessoal.
- O agente pode **abrir abas, ler páginas, clicar e digitar** em um ambiente seguro.
- O perfil padrão `chrome` usa o **navegador Chromium padrão do sistema** via o
  relay de extensão; mude para `openclaw` para o navegador gerenciado e isolado.

## O que você recebe

- Um perfil de navegador separado chamado **openclaw** (acento laranja por padrão).
- Controle determinístico de abas (listar/abrir/focar/fechar).
- Ações do agente (clicar/digitar/arrastar/selecionar), snapshots, capturas de tela, PDFs.
- Suporte opcional a múltiplos perfis (`openclaw`, `work`, `remote`, ...).

Este navegador **não** é para uso diário. Ele é uma superfície segura e isolada para
automação e verificação por agentes.

## Início rápido

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

Se aparecer “Browser disabled”, habilite-o na configuração (veja abaixo) e reinicie o
Gateway.

## Perfis: `openclaw` vs `chrome`

- `openclaw`: navegador gerenciado e isolado (não requer extensão).
- `chrome`: relay de extensão para o **navegador do sistema** (requer que a extensão do OpenClaw
  esteja anexada a uma aba).

Defina `browser.defaultProfile: "openclaw"` se você quiser o modo gerenciado como padrão.

## Configuração

As configurações do navegador ficam em `~/.openclaw/openclaw.json`.

```json5
{
  browser: {
    enabled: true, // default: true
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    remoteCdpTimeoutMs: 1500, // remote CDP HTTP timeout (ms)
    remoteCdpHandshakeTimeoutMs: 3000, // remote CDP WebSocket handshake timeout (ms)
    defaultProfile: "chrome",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
  },
}
```

Notas:

- O serviço de controle do navegador se vincula ao loopback em uma porta derivada de `gateway.port`
  (padrão: `18791`, que é gateway + 2). O relay usa a próxima porta (`18792`).
- Se você sobrescrever a porta do Gateway (`gateway.port` ou `OPENCLAW_GATEWAY_PORT`),
  as portas derivadas do navegador se ajustam para permanecer na mesma “família”.
- `cdpUrl` usa por padrão a porta do relay quando não está definido.
- `remoteCdpTimeoutMs` se aplica a verificações de alcançabilidade de CDP remoto (não-loopback).
- `remoteCdpHandshakeTimeoutMs` se aplica a verificações de alcançabilidade de WebSocket CDP remoto.
- `attachOnly: true` significa “nunca iniciar um navegador local; apenas anexar se já estiver em execução”.
- `color` + `color` por perfil aplicam um tom à UI do navegador para que você veja qual perfil está ativo.
- O perfil padrão é `chrome` (relay de extensão). Use `defaultProfile: "openclaw"` para o navegador gerenciado.
- Ordem de detecção automática: navegador padrão do sistema se for baseado em Chromium; caso contrário Chrome → Brave → Edge → Chromium → Chrome Canary.
- Perfis locais `openclaw` atribuem automaticamente `cdpPort`/`cdpUrl` — defina-os apenas para CDP remoto.

## Usar Brave (ou outro navegador baseado em Chromium)

Se o **navegador padrão do sistema** for baseado em Chromium (Chrome/Brave/Edge/etc),
o OpenClaw o usa automaticamente. Defina `browser.executablePath` para sobrescrever a
detecção automática:

Exemplo de CLI:

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
```

```json5
// macOS
{
  browser: {
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  }
}

// Windows
{
  browser: {
    executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  }
}

// Linux
{
  browser: {
    executablePath: "/usr/bin/brave-browser"
  }
}
```

## Controle local vs remoto

- **Controle local (padrão):** o Gateway inicia o serviço de controle em loopback e pode iniciar um navegador local.
- **Controle remoto (host de nó):** execute um host de nó na máquina que tem o navegador; o Gateway faz proxy das ações do navegador para ele.
- **CDP remoto:** defina `browser.profiles.<name>.cdpUrl` (ou `browser.cdpUrl`) para
  anexar a um navegador baseado em Chromium remoto. Nesse caso, o OpenClaw não iniciará um navegador local.

URLs de CDP remoto podem incluir autenticação:

- Tokens em query (ex.: `https://provider.example?token=<token>`)
- Autenticação HTTP Basic (ex.: `https://user:pass@provider.example`)

O OpenClaw preserva a autenticação ao chamar endpoints `/json/*` e ao conectar
ao WebSocket CDP. Prefira variáveis de ambiente ou gerenciadores de segredos para
tokens em vez de confirmá-los em arquivos de configuração.

## Proxy de navegador do nó (padrão zero-config)

Se você executar um **host de nó** na máquina que tem o navegador, o OpenClaw pode
rotear automaticamente chamadas de ferramentas de navegador para esse nó sem
qualquer configuração extra do navegador.
Este é o caminho padrão para gateways remotos.

Notas:

- O host de nó expõe seu servidor local de controle do navegador por meio de um **comando de proxy**.
- Os perfis vêm da própria configuração `browser.profiles` do nó (igual ao local).
- Desative se você não quiser:
  - No nó: `nodeHost.browserProxy.enabled=false`
  - No gateway: `gateway.nodes.browser.mode="off"`

## Browserless (CDP remoto hospedado)

O [Browserless](https://browserless.io) é um serviço Chromium hospedado que expõe
endpoints CDP via HTTPS. Você pode apontar um perfil de navegador do OpenClaw para um
endpoint regional do Browserless e autenticar com sua chave de API.

Exemplo:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserless",
    remoteCdpTimeoutMs: 2000,
    remoteCdpHandshakeTimeoutMs: 4000,
    profiles: {
      browserless: {
        cdpUrl: "https://production-sfo.browserless.io?token=<BROWSERLESS_API_KEY>",
        color: "#00AA00",
      },
    },
  },
}
```

Notas:

- Substitua `<BROWSERLESS_API_KEY>` pelo seu token real do Browserless.
- Escolha o endpoint de região que corresponda à sua conta do Browserless (veja a documentação deles).

## Segurança

Ideias-chave:

- O controle do navegador é apenas em loopback; o acesso flui pela autenticação do Gateway ou pelo pareamento de nós.
- Mantenha o Gateway e quaisquer hosts de nó em uma rede privada (Tailscale); evite exposição pública.
- Trate URLs/tokens de CDP remoto como segredos; prefira variáveis de ambiente ou um gerenciador de segredos.

Dicas de CDP remoto:

- Prefira endpoints HTTPS e tokens de curta duração quando possível.
- Evite embutir tokens de longa duração diretamente em arquivos de configuração.

## Perfis (multi-navegador)

O OpenClaw suporta vários perfis nomeados (configurações de roteamento). Os perfis podem ser:

- **openclaw-managed**: uma instância dedicada de navegador baseado em Chromium com seu próprio diretório de dados do usuário + porta CDP
- **remote**: uma URL CDP explícita (navegador baseado em Chromium executando em outro lugar)
- **extension relay**: suas abas existentes do Chrome via o relay local + extensão do Chrome

Padrões:

- O perfil `openclaw` é criado automaticamente se estiver ausente.
- O perfil `chrome` é integrado para o relay da extensão do Chrome (aponta para `http://127.0.0.1:18792` por padrão).
- As portas CDP locais alocam de **18800–18899** por padrão.
- Excluir um perfil move seu diretório de dados local para a Lixeira.

Todos os endpoints de controle aceitam `?profile=<name>`; a CLI usa `--browser-profile`.

## Relay da extensão do Chrome (use seu Chrome existente)

O OpenClaw também pode dirigir **suas abas existentes do Chrome** (sem uma instância separada do Chrome “openclaw”) via um relay CDP local + uma extensão do Chrome.

Guia completo: [Extensão do Chrome](/tools/chrome-extension)

Fluxo:

- O Gateway roda localmente (mesma máquina) ou um host de nó roda na máquina do navegador.
- Um **servidor de relay** local escuta em um `cdpUrl` de loopback (padrão: `http://127.0.0.1:18792`).
- Você clica no ícone da extensão **OpenClaw Browser Relay** em uma aba para anexar (ele não anexa automaticamente).
- O agente controla essa aba por meio da ferramenta normal `browser`, selecionando o perfil correto.

Se o Gateway rodar em outro lugar, execute um host de nó na máquina do navegador para que o Gateway possa fazer proxy das ações do navegador.

### Sessões em sandbox

Se a sessão do agente estiver em sandbox, a ferramenta `browser` pode usar por padrão `target="sandbox"` (navegador em sandbox).
A tomada de controle via relay da extensão do Chrome requer controle do navegador do host, então:

- execute a sessão fora do sandbox, ou
- defina `agents.defaults.sandbox.browser.allowHostControl: true` e use `target="host"` ao chamar a ferramenta.

### Configuração

1. Carregue a extensão (dev/desempacotada):

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → habilite “Developer mode”
- “Load unpacked” → selecione o diretório impresso por `openclaw browser extension path`
- Fixe a extensão e, em seguida, clique nela na aba que você quer controlar (o badge mostra `ON`).

2. Use:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Ferramenta do agente: `browser` com `profile="chrome"`

Opcional: se você quiser um nome diferente ou outra porta de relay, crie seu próprio perfil:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

Notas:

- Este modo depende do Playwright-on-CDP para a maioria das operações (capturas de tela/snapshots/ações).
- Desanexe clicando novamente no ícone da extensão.

## Garantias de isolamento

- **Diretório de dados do usuário dedicado**: nunca toca no perfil do seu navegador pessoal.
- **Portas dedicadas**: evita `9222` para prevenir colisões com fluxos de trabalho de desenvolvimento.
- **Controle determinístico de abas**: direciona abas por `targetId`, não pela “última aba”.

## Seleção de navegador

Ao iniciar localmente, o OpenClaw escolhe o primeiro disponível:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

Você pode sobrescrever com `browser.executablePath`.

Plataformas:

- macOS: verifica `/Applications` e `~/Applications`.
- Linux: procura `google-chrome`, `brave`, `microsoft-edge`, `chromium`, etc.
- Windows: verifica locais comuns de instalação.

## API de controle (opcional)

Apenas para integrações locais, o Gateway expõe uma pequena API HTTP em loopback:

- Status/iniciar/parar: `GET /`, `POST /start`, `POST /stop`
- Abas: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- Snapshot/captura de tela: `GET /snapshot`, `POST /screenshot`
- Ações: `POST /navigate`, `POST /act`
- Hooks: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- Downloads: `POST /download`, `POST /wait/download`
- Depuração: `GET /console`, `POST /pdf`
- Depuração: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- Rede: `POST /response/body`
- Estado: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- Estado: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- Configurações: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

Todos os endpoints aceitam `?profile=<name>`.

### Requisito do Playwright

Alguns recursos (navegar/agir/snapshot de IA/snapshot por função, capturas de elementos, PDF) exigem
Playwright. Se o Playwright não estiver instalado, esses endpoints retornam um erro
501 claro. Snapshots ARIA e capturas de tela básicas ainda funcionam para o Chrome gerenciado pelo openclaw.
Para o driver de relay da extensão do Chrome, snapshots ARIA e capturas de tela exigem Playwright.

Se você vir `Playwright is not available in this gateway build`, instale o pacote completo do
Playwright (não `playwright-core`) e reinicie o gateway, ou reinstale o
OpenClaw com suporte a navegador.

#### Instalação do Playwright no Docker

Se o seu Gateway roda em Docker, evite `npx playwright` (conflitos de override do npm).
Use a CLI empacotada:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Para persistir downloads do navegador, defina `PLAYWRIGHT_BROWSERS_PATH` (por exemplo,
`/home/node/.cache/ms-playwright`) e garanta que `/home/node` seja persistido via
`OPENCLAW_HOME_VOLUME` ou um bind mount. Veja [Docker](/install/docker).

## Como funciona (interno)

Fluxo de alto nível:

- Um pequeno **servidor de controle** aceita requisições HTTP.
- Ele se conecta a navegadores baseados em Chromium (Chrome/Brave/Edge/Chromium) via **CDP**.
- Para ações avançadas (clicar/digitar/snapshot/PDF), usa **Playwright** sobre
  o CDP.
- Quando o Playwright está ausente, apenas operações que não dependem do Playwright ficam disponíveis.

Este design mantém o agente em uma interface estável e determinística enquanto
permite alternar navegadores locais/remotos e perfis.

## Referência rápida da CLI

Todos os comandos aceitam `--browser-profile <name>` para direcionar um perfil específico.
Todos os comandos também aceitam `--json` para saída legível por máquina (payloads estáveis).

Básicos:

- `openclaw browser status`
- `openclaw browser start`
- `openclaw browser stop`
- `openclaw browser tabs`
- `openclaw browser tab`
- `openclaw browser tab new`
- `openclaw browser tab select 2`
- `openclaw browser tab close 2`
- `openclaw browser open https://example.com`
- `openclaw browser focus abcd1234`
- `openclaw browser close abcd1234`

Inspeção:

- `openclaw browser screenshot`
- `openclaw browser screenshot --full-page`
- `openclaw browser screenshot --ref 12`
- `openclaw browser screenshot --ref e12`
- `openclaw browser snapshot`
- `openclaw browser snapshot --format aria --limit 200`
- `openclaw browser snapshot --interactive --compact --depth 6`
- `openclaw browser snapshot --efficient`
- `openclaw browser snapshot --labels`
- `openclaw browser snapshot --selector "#main" --interactive`
- `openclaw browser snapshot --frame "iframe#main" --interactive`
- `openclaw browser console --level error`
- `openclaw browser errors --clear`
- `openclaw browser requests --filter api --clear`
- `openclaw browser pdf`
- `openclaw browser responsebody "**/api" --max-chars 5000`

Ações:

- `openclaw browser navigate https://example.com`
- `openclaw browser resize 1280 720`
- `openclaw browser click 12 --double`
- `openclaw browser click e12 --double`
- `openclaw browser type 23 "hello" --submit`
- `openclaw browser press Enter`
- `openclaw browser hover 44`
- `openclaw browser scrollintoview e12`
- `openclaw browser drag 10 11`
- `openclaw browser select 9 OptionA OptionB`
- `openclaw browser download e12 /tmp/report.pdf`
- `openclaw browser waitfordownload /tmp/report.pdf`
- `openclaw browser upload /tmp/file.pdf`
- `openclaw browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'`
- `openclaw browser dialog --accept`
- `openclaw browser wait --text "Done"`
- `openclaw browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"`
- `openclaw browser evaluate --fn '(el) => el.textContent' --ref 7`
- `openclaw browser highlight e12`
- `openclaw browser trace start`
- `openclaw browser trace stop`

Estado:

- `openclaw browser cookies`
- `openclaw browser cookies set session abc123 --url "https://example.com"`
- `openclaw browser cookies clear`
- `openclaw browser storage local get`
- `openclaw browser storage local set theme dark`
- `openclaw browser storage session clear`
- `openclaw browser set offline on`
- `openclaw browser set headers --json '{"X-Debug":"1"}'`
- `openclaw browser set credentials user pass`
- `openclaw browser set credentials --clear`
- `openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"`
- `openclaw browser set geo --clear`
- `openclaw browser set media dark`
- `openclaw browser set timezone America/New_York`
- `openclaw browser set locale en-US`
- `openclaw browser set device "iPhone 14"`

Notas:

- `upload` e `dialog` são chamadas de **armar**; execute-as antes do clique/pressionamento
  que dispara o seletor/diálogo.
- `upload` também pode definir inputs de arquivo diretamente via `--input-ref` ou `--element`.
- `snapshot`:
  - `--format ai` (padrão quando o Playwright está instalado): retorna um snapshot de IA com referências numéricas (`aria-ref="<n>"`).
  - `--format aria`: retorna a árvore de acessibilidade (sem refs; apenas inspeção).
  - `--efficient` (ou `--mode efficient`): preset compacto de snapshot por função (interativo + compacto + profundidade + maxChars menor).
  - Padrão de configuração (apenas ferramenta/CLI): defina `browser.snapshotDefaults.mode: "efficient"` para usar snapshots eficientes quando o chamador não passa um modo (veja [Configuração do Gateway](/gateway/configuration#browser-openclaw-managed-browser)).
  - Opções de snapshot por função (`--interactive`, `--compact`, `--depth`, `--selector`) forçam um snapshot baseado em função com refs como `ref=e12`.
  - `--frame "<iframe selector>"` delimita snapshots por função a um iframe (combina com refs de função como `e12`).
  - `--interactive` produz uma lista plana e fácil de selecionar de elementos interativos (melhor para conduzir ações).
  - `--labels` adiciona uma captura de tela apenas do viewport com rótulos de ref sobrepostos (imprime `MEDIA:<path>`).
- `click`/`type`/etc exigem um `ref` de `snapshot` (seja numérico `12` ou ref por função `e12`).
  Seletores CSS intencionalmente não são suportados para ações.

## Snapshots e refs

O OpenClaw suporta dois estilos de “snapshot”:

- **Snapshot de IA (refs numéricas)**: `openclaw browser snapshot` (padrão; `--format ai`)
  - Saída: um snapshot em texto que inclui refs numéricas.
  - Ações: `openclaw browser click 12`, `openclaw browser type 23 "hello"`.
  - Internamente, a ref é resolvida via `aria-ref` do Playwright.

- **Snapshot por função (refs por função como `e12`)**: `openclaw browser snapshot --interactive` (ou `--compact`, `--depth`, `--selector`, `--frame`)
  - Saída: uma lista/árvore baseada em função com `[ref=e12]` (e opcional `[nth=1]`).
  - Ações: `openclaw browser click e12`, `openclaw browser highlight e12`.
  - Internamente, a ref é resolvida via `getByRole(...)` (mais `nth()` para duplicatas).
  - Adicione `--labels` para incluir uma captura de tela do viewport com rótulos `e12` sobrepostos.

Comportamento das refs:

- As refs **não são estáveis entre navegações**; se algo falhar, execute novamente `snapshot` e use uma ref nova.
- Se o snapshot por função foi feito com `--frame`, as refs por função ficam delimitadas a esse iframe até o próximo snapshot por função.

## Power-ups de espera

Você pode esperar por mais do que apenas tempo/texto:

- Esperar por URL (globs suportados pelo Playwright):
  - `openclaw browser wait --url "**/dash"`
- Esperar por estado de carregamento:
  - `openclaw browser wait --load networkidle`
- Esperar por um predicado JS:
  - `openclaw browser wait --fn "window.ready===true"`
- Esperar que um seletor se torne visível:
  - `openclaw browser wait "#main"`

Eles podem ser combinados:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## Depurar workflows

Quando uma ação falha (ex.: “not visible”, “strict mode violation”, “covered”):

1. `openclaw browser snapshot --interactive`
2. Use `click <ref>` / `type <ref>` (prefira refs por função no modo interativo)
3. Se ainda falhar: `openclaw browser highlight <ref>` para ver o que o Playwright está direcionando
4. Se a página se comportar de forma estranha:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. Para depuração profunda: registre um trace:
   - `openclaw browser trace start`
   - reproduza o problema
   - `openclaw browser trace stop` (imprime `TRACE:<path>`)

## Saída JSON

`--json` é para scripts e ferramentas estruturadas.

Exemplos:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

Snapshots por função em JSON incluem `refs` mais um pequeno bloco `stats` (linhas/chars/refs/interativo) para que ferramentas possam raciocinar sobre tamanho e densidade do payload.

## Controles de estado e ambiente

Eles são úteis para fluxos “fazer o site se comportar como X”:

- Cookies: `cookies`, `cookies set`, `cookies clear`
- Armazenamento: `storage local|session get|set|clear`
- Offline: `set offline on|off`
- Cabeçalhos: `set headers --json '{"X-Debug":"1"}'` (ou `--clear`)
- Autenticação HTTP basic: `set credentials user pass` (ou `--clear`)
- Geolocalização: `set geo <lat> <lon> --origin "https://example.com"` (ou `--clear`)
- Mídia: `set media dark|light|no-preference|none`
- Fuso horário / localidade: `set timezone ...`, `set locale ...`
- Dispositivo / viewport:
  - `set device "iPhone 14"` (presets de dispositivo do Playwright)
  - `set viewport 1280 720`

## Segurança e privacidade

- O perfil de navegador openclaw pode conter sessões logadas; trate-o como sensível.
- `browser act kind=evaluate` / `openclaw browser evaluate` e `wait --fn`
  executam JavaScript arbitrário no contexto da página. Injeção de prompt pode direcionar
  isso. Desative com `browser.evaluateEnabled=false` se você não precisar.
- Para logins e notas anti-bot (X/Twitter, etc.), veja [Login no navegador + postagem no X/Twitter](/tools/browser-login).
- Mantenha o Gateway/host de nó privado (apenas loopback ou tailnet).
- Endpoints CDP remotos são poderosos; tunnele e proteja-os.

## Solução de problemas

Para problemas específicos do Linux (especialmente Chromium snap), veja
[Solução de problemas do navegador](/tools/browser-linux-troubleshooting).

## Ferramentas do agente + como o controle funciona

O agente recebe **uma ferramenta** para automação de navegador:

- `browser` — status/iniciar/parar/abas/abrir/focar/fechar/snapshot/captura de tela/navegar/agir

Como mapeia:

- `browser snapshot` retorna uma árvore de UI estável (IA ou ARIA).
- `browser act` usa os IDs `ref` do snapshot para clicar/digitar/arrastar/selecionar.
- `browser screenshot` captura pixels (página inteira ou elemento).
- `browser` aceita:
  - `profile` para escolher um perfil de navegador nomeado (openclaw, chrome ou CDP remoto).
  - `target` (`sandbox` | `host` | `node`) para selecionar onde o navegador reside.
  - Em sessões em sandbox, `target: "host"` exige `agents.defaults.sandbox.browser.allowHostControl=true`.
  - Se `target` for omitido: sessões em sandbox usam por padrão `sandbox`, sessões fora de sandbox usam por padrão `host`.
  - Se um nó com capacidade de navegador estiver conectado, a ferramenta pode rotear automaticamente para ele, a menos que você fixe `target="host"` ou `target="node"`.

Isso mantém o agente determinístico e evita seletores frágeis.
