---
summary: "Plano: um SDK de plugin + runtime limpos para todos os conectores de mensagens"
read_when:
  - Definindo ou refatorando a arquitetura de plugins
  - Migrando conectores de canal para o SDK/runtime de plugins
title: "Refatoração do SDK de Plugin"
x-i18n:
  source_path: refactor/plugin-sdk.md
  source_hash: 1f3519f43632fcac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:31:50Z
---

# Plano de Refatoração do SDK + Runtime de Plugin

Objetivo: todo conector de mensagens é um plugin (empacotado ou externo) usando uma única API estável.
Nenhum plugin importa `src/**` diretamente. Todas as dependências passam pelo SDK ou pelo runtime.

## Por que agora

- Os conectores atuais misturam padrões: imports diretos do core, bridges apenas de dist e helpers personalizados.
- Isso torna as atualizações frágeis e bloqueia uma superfície limpa para plugins externos.

## Arquitetura alvo (duas camadas)

### 1) SDK de Plugin (tempo de compilação, estável, publicável)

Escopo: tipos, helpers e utilitários de configuração. Sem estado de runtime, sem efeitos colaterais.

Conteúdo (exemplos):

- Tipos: `ChannelPlugin`, adapters, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.
- Helpers de configuração: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,
  `applyAccountNameToChannelSection`.
- Helpers de pareamento: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.
- Helpers de onboarding: `promptChannelAccessConfig`, `addWildcardAllowFrom`, tipos de onboarding.
- Helpers de parâmetros de ferramenta: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.
- Helper de link de docs: `formatDocsLink`.

Entrega:

- Publicar como `openclaw/plugin-sdk` (ou exportar do core sob `openclaw/plugin-sdk`).
- Semver com garantias explícitas de estabilidade.

### 2) Runtime de Plugin (superfície de execução, injetado)

Escopo: tudo o que toca o comportamento do runtime do core.
Acessado via `OpenClawPluginApi.runtime` para que os plugins nunca importem `src/**`.

Superfície proposta (mínima, mas completa):

```ts
export type PluginRuntime = {
  channel: {
    text: {
      chunkMarkdownText(text: string, limit: number): string[];
      resolveTextChunkLimit(cfg: OpenClawConfig, channel: string, accountId?: string): number;
      hasControlCommand(text: string, cfg: OpenClawConfig): boolean;
    };
    reply: {
      dispatchReplyWithBufferedBlockDispatcher(params: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: {
            text?: string;
            mediaUrls?: string[];
            mediaUrl?: string;
          }) => void | Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        };
      }): Promise<void>;
      createReplyDispatcherWithTyping?: unknown; // adapter for Teams-style flows
    };
    routing: {
      resolveAgentRoute(params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: "dm" | "group" | "channel"; id: string };
      }): { sessionKey: string; accountId: string };
    };
    pairing: {
      buildPairingReply(params: { channel: string; idLine: string; code: string }): string;
      readAllowFromStore(channel: string): Promise<string[]>;
      upsertPairingRequest(params: {
        channel: string;
        id: string;
        meta?: { name?: string };
      }): Promise<{ code: string; created: boolean }>;
    };
    media: {
      fetchRemoteMedia(params: { url: string }): Promise<{ buffer: Buffer; contentType?: string }>;
      saveMediaBuffer(
        buffer: Uint8Array,
        contentType: string | undefined,
        direction: "inbound" | "outbound",
        maxBytes: number,
      ): Promise<{ path: string; contentType?: string }>;
    };
    mentions: {
      buildMentionRegexes(cfg: OpenClawConfig, agentId?: string): RegExp[];
      matchesMentionPatterns(text: string, regexes: RegExp[]): boolean;
    };
    groups: {
      resolveGroupPolicy(
        cfg: OpenClawConfig,
        channel: string,
        accountId: string,
        groupId: string,
      ): {
        allowlistEnabled: boolean;
        allowed: boolean;
        groupConfig?: unknown;
        defaultConfig?: unknown;
      };
      resolveRequireMention(
        cfg: OpenClawConfig,
        channel: string,
        accountId: string,
        groupId: string,
        override?: boolean,
      ): boolean;
    };
    debounce: {
      createInboundDebouncer<T>(opts: {
        debounceMs: number;
        buildKey: (v: T) => string | null;
        shouldDebounce: (v: T) => boolean;
        onFlush: (entries: T[]) => Promise<void>;
        onError?: (err: unknown) => void;
      }): { push: (v: T) => void; flush: () => Promise<void> };
      resolveInboundDebounceMs(cfg: OpenClawConfig, channel: string): number;
    };
    commands: {
      resolveCommandAuthorizedFromAuthorizers(params: {
        useAccessGroups: boolean;
        authorizers: Array<{ configured: boolean; allowed: boolean }>;
      }): boolean;
    };
  };
  logging: {
    shouldLogVerbose(): boolean;
    getChildLogger(name: string): PluginLogger;
  };
  state: {
    resolveStateDir(cfg: OpenClawConfig): string;
  };
};
```

Notas:

- O runtime é a única forma de acessar o comportamento do core.
- O SDK é intencionalmente pequeno e estável.
- Cada método do runtime mapeia para uma implementação existente do core (sem duplicação).

## Plano de migração (em fases, seguro)

### Fase 0: scaffolding

- Introduzir `openclaw/plugin-sdk`.
- Adicionar `api.runtime` a `OpenClawPluginApi` com a superfície acima.
- Manter imports existentes durante uma janela de transição (avisos de depreciação).

### Fase 1: limpeza de bridges (baixo risco)

- Substituir `core-bridge.ts` por extensão por `api.runtime`.
- Migrar BlueBubbles, Zalo, Zalo Personal primeiro (já estão próximos).
- Remover código de bridge duplicado.

### Fase 2: plugins com imports diretos leves

- Migrar Matrix para SDK + runtime.
- Validar lógica de onboarding, diretório e menção de grupo.

### Fase 3: plugins com imports diretos pesados

- Migrar MS Teams (maior conjunto de helpers de runtime).
- Garantir que a semântica de resposta/digitação corresponda ao comportamento atual.

### Fase 4: pluginização do iMessage

- Mover iMessage para `extensions/imessage`.
- Substituir chamadas diretas ao core por `api.runtime`.
- Manter chaves de configuração, comportamento da CLI e docs intactos.

### Fase 5: enforcement

- Adicionar regra de lint / verificação de CI: nenhum import `extensions/**` a partir de `src/**`.
- Adicionar verificações de compatibilidade de SDK/versão de plugin (runtime + semver do SDK).

## Compatibilidade e versionamento

- SDK: semver, publicado, mudanças documentadas.
- Runtime: versionado por release do core. Adicionar `api.runtime.version`.
- Plugins declaram um intervalo de runtime requerido (por exemplo, `openclawRuntime: ">=2026.2.0"`).

## Estratégia de testes

- Testes unitários no nível de adapter (funções do runtime exercitadas com implementação real do core).
- Testes golden por plugin: garantir ausência de desvio de comportamento (roteamento, pareamento, lista de permissões, gating de menções).
- Um único plugin de exemplo end-to-end usado no CI (instalar + executar + smoke).

## Questões em aberto

- Onde hospedar os tipos do SDK: pacote separado ou exportação do core?
- Distribuição dos tipos do runtime: no SDK (apenas tipos) ou no core?
- Como expor links de docs para plugins empacotados vs externos?
- Permitimos imports diretos limitados do core para plugins no repositório durante a transição?

## Critérios de sucesso

- Todos os conectores de canal são plugins usando SDK + runtime.
- Nenhum import `extensions/**` a partir de `src/**`.
- Novos templates de conector dependem apenas de SDK + runtime.
- Plugins externos podem ser desenvolvidos e atualizados sem acesso ao código-fonte do core.

Documentos relacionados: [Plugins](/tools/plugin), [Channels](/channels/index), [Configuration](/gateway/configuration).
