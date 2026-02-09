---
summary: "Plugins/extensões do OpenClaw: descoberta, configuração e segurança"
read_when:
  - Ao adicionar ou modificar plugins/extensões
  - Ao documentar regras de instalação ou carregamento de plugins
title: "Plugins"
---

# Plugins (Extensões)

## Início rápido (novo em plugins?)

Um plugin é apenas um **pequeno módulo de código** que estende o OpenClaw com
recursos extras (comandos, ferramentas e RPC do Gateway).

Na maioria das vezes, você usará plugins quando quiser um recurso que ainda não
está embutido no OpenClaw principal (ou quando quiser manter recursos opcionais
fora da sua instalação principal).

Caminho rápido:

1. Veja o que já está carregado:

```bash
openclaw plugins list
```

2. Instale um plugin oficial (exemplo: Voice Call):

```bash
openclaw plugins install @openclaw/voice-call
```

3. Reinicie o Gateway e depois configure em `plugins.entries.<id>.config`.

Veja [Voice Call](/plugins/voice-call) para um exemplo concreto de plugin.

## Plugins disponíveis (oficiais)

- Microsoft Teams é apenas via plugin a partir de 2026.1.15; instale `@openclaw/msteams` se você usa Teams.
- Memory (Core) — plugin de busca de memória empacotado (habilitado por padrão via `plugins.slots.memory`)
- Memory (LanceDB) — plugin de memória de longo prazo empacotado (auto-recall/capture; defina `plugins.slots.memory = "memory-lancedb"`)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (autenticação de provedor) — empacotado como `google-antigravity-auth` (desabilitado por padrão)
- Gemini CLI OAuth (autenticação de provedor) — empacotado como `google-gemini-cli-auth` (desabilitado por padrão)
- Qwen OAuth (autenticação de provedor) — empacotado como `qwen-portal-auth` (desabilitado por padrão)
- Copilot Proxy (autenticação de provedor) — ponte local do VS Code Copilot Proxy; distinto do login de dispositivo embutido `github-copilot` (empacotado, desabilitado por padrão)

Os plugins do OpenClaw são **módulos TypeScript** carregados em tempo de execução via jiti. **A validação de configuração não executa código do plugin**; ela usa o manifesto do plugin e o JSON Schema. Veja [Plugin manifest](/plugins/manifest).

Os plugins podem registrar:

- Métodos de RPC do Gateway
- Handlers HTTP do Gateway
- Ferramentas de agente
- Comandos de CLI
- Serviços em segundo plano
- Validação opcional de configuração
- **Skills** (listando diretórios `skills` no manifesto do plugin)
- **Comandos de resposta automática** (executam sem invocar o agente de IA)

Os plugins rodam **no mesmo processo** do Gateway, portanto trate-os como código confiável.
Guia de criação de ferramentas: [Plugin agent tools](/plugins/agent-tools).

## Ajudantes de runtime

Os plugins podem acessar ajudantes principais selecionados via `api.runtime`. Para TTS de telefonia:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

Notas:

- Usa a configuração principal `messages.tts` (OpenAI ou ElevenLabs).
- Retorna buffer de áudio PCM + taxa de amostragem. Os plugins devem reamostrar/codificar para os provedores.
- Edge TTS não é suportado para telefonia.

## Descoberta e precedência

O OpenClaw varre, em ordem:

1. Caminhos de configuração

- `plugins.load.paths` (arquivo ou diretório)

2. Extensões do workspace

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. Extensões globais

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. Extensões empacotadas (enviadas com o OpenClaw, **desabilitadas por padrão**)

- `<openclaw>/extensions/*`

Plugins empacotados devem ser habilitados explicitamente via `plugins.entries.<id>.enabled`
ou `openclaw plugins enable <id>`. Plugins instalados são habilitados por padrão,
mas podem ser desabilitados da mesma forma.

Cada plugin deve incluir um arquivo `openclaw.plugin.json` em sua raiz. Se um caminho
apontar para um arquivo, a raiz do plugin é o diretório do arquivo e deve conter
o manifesto.

Se vários plugins resolverem para o mesmo id, a primeira correspondência na ordem acima
vence e as cópias de menor precedência são ignoradas.

### Pacotes de pacotes

Um diretório de plugin pode incluir um `package.json` com `openclaw.extensions`:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

Cada entrada se torna um plugin. Se o pacote listar várias extensões, o id do plugin
se torna `name/<fileBase>`.

Se o seu plugin importar dependências npm, instale-as nesse diretório para que
`node_modules` esteja disponível (`npm install` / `pnpm install`).

### Metadados do catálogo de canais

Plugins de canal podem anunciar metadados de integração inicial via `openclaw.channel` e
dicas de instalação via `openclaw.install`. Isso mantém o catálogo principal livre de dados.

Exemplo:

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk (self-hosted)",
      "docsPath": "/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "Self-hosted chat via Nextcloud Talk webhook bots.",
      "order": 65,
      "aliases": ["nc-talk", "nc"]
    },
    "install": {
      "npmSpec": "@openclaw/nextcloud-talk",
      "localPath": "extensions/nextcloud-talk",
      "defaultChoice": "npm"
    }
  }
}
```

O OpenClaw também pode mesclar **catálogos de canais externos** (por exemplo, uma exportação
de registro MPM). Coloque um arquivo JSON em um dos seguintes caminhos:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

Ou aponte `OPENCLAW_PLUGIN_CATALOG_PATHS` (ou `OPENCLAW_MPM_CATALOG_PATHS`) para
um ou mais arquivos JSON (delimitados por vírgula/ponto e vírgula/`PATH`). Cada arquivo deve
conter `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`.

## IDs de plugin

IDs de plugin padrão:

- Pacotes de pacotes: `package.json` `name`
- Arquivo standalone: nome base do arquivo (`~/.../voice-call.ts` → `voice-call`)

Se um plugin exportar `id`, o OpenClaw o usa, mas avisa quando não corresponde ao
id configurado.

## Configuração

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-extension"] },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } },
    },
  },
}
```

Campos:

- `enabled`: alternância mestre (padrão: true)
- `allow`: lista de permissões (opcional)
- `deny`: lista de negação (opcional; a negação vence)
- `load.paths`: arquivos/diretórios extras de plugin
- `entries.<id>`: alternâncias por plugin + configuração

Alterações de configuração **exigem reinício do gateway**.

Regras de validação (estritas):

- IDs de plugin desconhecidos em `entries`, `allow`, `deny` ou `slots` são **erros**.
- Chaves `channels.<id>` desconhecidas são **erros**, a menos que um manifesto de plugin declare
  o id do canal.
- A configuração do plugin é validada usando o JSON Schema incorporado em
  `openclaw.plugin.json` (`configSchema`).
- Se um plugin estiver desabilitado, sua configuração é preservada e um **aviso** é emitido.

## Slots de plugin (categorias exclusivas)

Algumas categorias de plugin são **exclusivas** (apenas uma ativa por vez). Use
`plugins.slots` para selecionar qual plugin é dono do slot:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

Se vários plugins declararem `kind: "memory"`, apenas o selecionado carrega. Os outros
são desabilitados com diagnósticos.

## UI de controle (schema + rótulos)

A UI de Controle usa `config.schema` (JSON Schema + `uiHints`) para renderizar formulários melhores.

O OpenClaw amplia `uiHints` em tempo de execução com base nos plugins descobertos:

- Adiciona rótulos por plugin para `plugins.entries.<id>` / `.enabled` / `.config`
- Mescla dicas opcionais de campos de configuração fornecidas pelo plugin em:
  `plugins.entries.<id>.config.<field>`

Se você quiser que os campos de configuração do seu plugin exibam bons rótulos/placeholders
(e marquem segredos como sensíveis), forneça `uiHints` junto com seu JSON Schema no manifesto do plugin.

Exemplo:

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": { "type": "string" },
      "region": { "type": "string" }
    }
  },
  "uiHints": {
    "apiKey": { "label": "API Key", "sensitive": true },
    "region": { "label": "Region", "placeholder": "us-east-1" }
  }
}
```

## CLI

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins install <path>                 # copy a local file/dir into ~/.openclaw/extensions/<id>
openclaw plugins install ./extensions/voice-call # relative path ok
openclaw plugins install ./plugin.tgz           # install from a local tarball
openclaw plugins install ./plugin.zip           # install from a local zip
openclaw plugins install -l ./extensions/voice-call # link (no copy) for dev
openclaw plugins install @openclaw/voice-call # install from npm
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` funciona apenas para instalações npm rastreadas em `plugins.installs`.

Os plugins também podem registrar seus próprios comandos de nível superior (exemplo: `openclaw voicecall`).

## API de Plugin (visão geral)

Os plugins exportam um de:

- Uma função: `(api) => { ... }`
- Um objeto: `{ id, name, configSchema, register(api) { ... } }`

## Hooks de plugin

Os plugins podem enviar hooks e registrá-los em tempo de execução. Os plugins podem incluir hooks e registrá-los em tempo de execução. Isso permite que um plugin
empacote automação orientada a eventos sem uma instalação separada de pacote de hooks.

### Exemplo

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

Notas:

- Diretórios de hooks seguem a estrutura normal de hooks (`HOOK.md` + `handler.ts`).
- As regras de elegibilidade de hooks ainda se aplicam (requisitos de SO/bins/env/config).
- Hooks gerenciados por plugin aparecem em `openclaw hooks list` com `plugin:<id>`.
- Você não pode habilitar/desabilitar hooks gerenciados por plugin via `openclaw hooks`; habilite/desabilite o plugin em vez disso.

## Plugins de provedor (autenticação de modelo)

Os plugins podem registrar fluxos de **autenticação de provedor de modelo** para que os usuários
possam executar OAuth ou configuração de chave de API dentro do OpenClaw (sem scripts externos).

Registre um provedor via `api.registerProvider(...)`. Cada provedor expõe um
ou mais métodos de autenticação (OAuth, chave de API, código de dispositivo etc.). Esses métodos alimentam:

- `openclaw models auth login --provider <id> [--method <id>]`

Exemplo:

```ts
api.registerProvider({
  id: "acme",
  label: "AcmeAI",
  auth: [
    {
      id: "oauth",
      label: "OAuth",
      kind: "oauth",
      run: async (ctx) => {
        // Run OAuth flow and return auth profiles.
        return {
          profiles: [
            {
              profileId: "acme:default",
              credential: {
                type: "oauth",
                provider: "acme",
                access: "...",
                refresh: "...",
                expires: Date.now() + 3600 * 1000,
              },
            },
          ],
          defaultModel: "acme/opus-1",
        };
      },
    },
  ],
});
```

Notas:

- `run` recebe um `ProviderAuthContext` com ajudantes `prompter`, `runtime`,
  `openUrl` e `oauth.createVpsAwareHandlers`.
- Retorne `configPatch` quando você precisar adicionar modelos padrão ou configuração do provedor.
- Retorne `defaultModel` para que `--set-default` possa atualizar os padrões do agente.

### Registrar um canal de mensagens

Os plugins podem registrar **plugins de canal** que se comportam como canais embutidos
(WhatsApp, Telegram etc.). A configuração do canal fica em `channels.<id>` e é
validada pelo código do seu plugin de canal.

```ts
const myChannel = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "demo channel plugin.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async () => ({ ok: true }),
  },
};

export default function (api) {
  api.registerChannel({ plugin: myChannel });
}
```

Notas:

- Coloque a configuração em `channels.<id>` (não em `plugins.entries`).
- `meta.label` é usado para rótulos em listas da CLI/UI.
- `meta.aliases` adiciona ids alternativos para normalização e entradas da CLI.
- `meta.preferOver` lista ids de canal para pular auto-habilitação quando ambos estiverem configurados.
- `meta.detailLabel` e `meta.systemImage` permitem que UIs mostrem rótulos/ícones de canal mais ricos.

### Escrever um novo canal de mensagens (passo a passo)

Use isto quando quiser uma **nova superfície de chat** (um “canal de mensagens”), não um provedor de modelo.
A documentação de provedores de modelo fica em `/providers/*`.

1. Escolha um id + formato de configuração

- Toda a configuração de canal fica em `channels.<id>`.
- Prefira `channels.<id>.accounts.<accountId>` para configurações multi‑conta.

2. Defina os metadados do canal

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` controlam listas da CLI/UI.
- `meta.docsPath` deve apontar para uma página de docs como `/channels/<id>`.
- `meta.preferOver` permite que um plugin substitua outro canal (a auto-habilitação o prefere).
- `meta.detailLabel` e `meta.systemImage` são usados pelas UIs para texto/ícones de detalhe.

3. Implemente os adaptadores obrigatórios

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (tipos de chat, mídia, threads etc.)
- `outbound.deliveryMode` + `outbound.sendText` (para envio básico)

4. Adicione adaptadores opcionais conforme necessário

- `setup` (assistente), `security` (política de DM), `status` (saúde/diagnósticos)
- `gateway` (start/stop/login), `mentions`, `threading`, `streaming`
- `actions` (ações de mensagem), `commands` (comportamento de comando nativo)

5. Registre o canal no seu plugin

- `api.registerChannel({ plugin })`

Exemplo mínimo de configuração:

```json5
{
  channels: {
    acmechat: {
      accounts: {
        default: { token: "ACME_TOKEN", enabled: true },
      },
    },
  },
}
```

Plugin mínimo de canal (apenas saída):

```ts
const plugin = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "AcmeChat messaging channel.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text }) => {
      // deliver `text` to your channel here
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

Carregue o plugin (diretório de extensões ou `plugins.load.paths`), reinicie o gateway,
depois configure `channels.<id>` na sua configuração.

### Ferramentas de agente

Veja o guia dedicado: [Plugin agent tools](/plugins/agent-tools).

### Registrar um método de RPC do gateway

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### Registrar comandos de CLI

```ts
export default function (api) {
  api.registerCli(
    ({ program }) => {
      program.command("mycmd").action(() => {
        console.log("Hello");
      });
    },
    { commands: ["mycmd"] },
  );
}
```

### Registrar comandos de resposta automática

Os plugins podem registrar comandos personalizados de barra que executam **sem invocar o
agente de IA**. Isso é útil para comandos de alternância, verificações de status ou ações rápidas
que não precisam de processamento por LLM.

```ts
export default function (api) {
  api.registerCommand({
    name: "mystatus",
    description: "Show plugin status",
    handler: (ctx) => ({
      text: `Plugin is running! Channel: ${ctx.channel}`,
    }),
  });
}
```

Contexto do manipulador de comando:

- `senderId`: O ID do remetente (se disponível)
- `channel`: O canal onde o comando foi enviado
- `isAuthorizedSender`: Se o remetente é um usuário autorizado
- `args`: Argumentos passados após o comando (se `acceptsArgs: true`)
- `commandBody`: O texto completo do comando
- `config`: A configuração atual do OpenClaw

Opções de comando:

- `name`: Nome do comando (sem o `/` inicial)
- `description`: Texto de ajuda mostrado em listas de comandos
- `acceptsArgs`: Se o comando aceita argumentos (padrão: false). Se false e argumentos forem fornecidos, o comando não corresponderá e a mensagem seguirá para outros manipuladores
- `requireAuth`: Se deve exigir remetente autorizado (padrão: true)
- `handler`: Função que retorna `{ text: string }` (pode ser async)

Exemplo com autorização e argumentos:

```ts
api.registerCommand({
  name: "setmode",
  description: "Set plugin mode",
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx) => {
    const mode = ctx.args?.trim() || "default";
    await saveMode(mode);
    return { text: `Mode set to: ${mode}` };
  },
});
```

Notas:

- Comandos de plugin são processados **antes** dos comandos embutidos e do agente de IA
- Os comandos são registrados globalmente e funcionam em todos os canais
- Nomes de comando não diferenciam maiúsculas/minúsculas (`/MyStatus` corresponde a `/mystatus`)
- Os nomes dos comandos devem começar com uma letra e conter apenas letras, números, hífens e sublinhados
- Nomes de comando reservados (como `help`, `status`, `reset`, etc.) não podem ser sobrescritos por plugins
- Registro duplicado de comandos entre plugins falhará com um erro de diagnóstico

### Registrar serviços em segundo plano

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## Convenções de nomenclatura

- Métodos do Gateway: `pluginId.action` (exemplo: `voicecall.status`)
- Ferramentas: `snake_case` (exemplo: `voice_call`)
- Comandos de CLI: kebab ou camel, mas evite conflito com comandos principais

## Skills

Os plugins podem incluir uma skill no repositório (`skills/<name>/SKILL.md`).
Habilite-a com `plugins.entries.<id>.enabled` (ou outros controles de configuração) e garanta
que ela esteja presente nos locais de skills do workspace/gerenciados.

## Distribuição (npm)

Empacotamento recomendado:

- Pacote principal: `openclaw` (este repositório)
- Plugins: pacotes npm separados sob `@openclaw/*` (exemplo: `@openclaw/voice-call`)

Contrato de publicação:

- O `package.json` do plugin deve incluir `openclaw.extensions` com um ou mais arquivos de entrada.
- Os arquivos de entrada podem ser `.js` ou `.ts` (jiti carrega TS em tempo de execução).
- `openclaw plugins install <npm-spec>` usa `npm pack`, extrai em `~/.openclaw/extensions/<id>/` e o habilita na configuração.
- Estabilidade da chave de configuração: pacotes com escopo são normalizados para o id **sem escopo** em `plugins.entries.*`.

## Plugin de exemplo: Voice Call

Este repositório inclui um plugin de chamada de voz (Twilio ou fallback de log):

- Código-fonte: `extensions/voice-call`
- Skill: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- Ferramenta: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- Configuração (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (opcional `statusCallbackUrl`, `twimlUrl`)
- Configuração (dev): `provider: "log"` (sem rede)

Veja [Voice Call](/plugins/voice-call) e `extensions/voice-call/README.md` para configuração e uso.

## Notas de segurança

Os plugins rodam no mesmo processo do Gateway. Trate-os como código confiável:

- Instale apenas plugins em que você confia.
- Prefira listas de permissões `plugins.allow`.
- Reinicie o Gateway após alterações.

## Testando plugins

Os plugins podem (e devem) incluir testes:

- Plugins no repositório podem manter testes Vitest em `src/**` (exemplo: `src/plugins/voice-call.plugin.test.ts`).
- Plugins publicados separadamente devem executar sua própria CI (lint/build/test) e validar que `openclaw.extensions` aponta para o entrypoint compilado (`dist/index.js`).
