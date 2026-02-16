---
summary: "Plan : un SDK plugin propre + runtime pour tous connecteurs messaging"
read_when:
  - Définition ou refactorisation architecture plugin
  - Migration connecteurs channel vers SDK/runtime plugin
title: "Refactor SDK Plugin"
---

# Plan Refactor SDK Plugin + Runtime

Objectif : chaque connecteur messaging est plugin (bundled ou externe) utilisant une API stable. Aucune importation plugin depuis `src/**` directement. Toutes dépendances passent par SDK ou runtime.

## Pourquoi maintenant

- Connecteurs actuels mélangent patterns : imports core directs, bridges dist-only et helpers custom.
- Cela rend upgrades fragiles et bloque surface plugin externe propre.

## Architecture cible (deux couches)

### 1) SDK Plugin (compile-time, stable, publiable)

Scope : types, helpers et utilitaires config. Aucun état runtime, aucun effet secondaire.

Contenus (exemples) :

- Types : `ChannelPlugin`, adapters, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.
- Helpers config : `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`, `applyAccountNameToChannelSection`.
- Helpers pairing : `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.
- Helpers onboarding : `promptChannelAccessConfig`, `addWildcardAllowFrom`, types onboarding.
- Helpers param tool : `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.
- Helper lien docs : `formatDocsLink`.

Livraison :

- Publier comme `openclaw/plugin-sdk` (ou exporter depuis core sous `openclaw/plugin-sdk`).
- Semver avec garanties stabilité explicites.

### 2) Runtime Plugin (surface exécution, injectée)

Scope : tout ce qui touche comportement runtime core. Accédé via `OpenClawPluginApi.runtime` donc plugins n'importent jamais `src/**`.

Surface proposée (minimale mais complète) :

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
      createReplyDispatcherWithTyping?: unknown;
    };
    routing: {
      resolveAgentRoute(params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: RoutePeerKind; id: string };
      }): { sessionKey: string; accountId: string };
    };
    pairing: {
      buildPairingReply(params: { channel: string; idLine: string; code: string }): string;
      readAllowFromStore(channel: string): Promise<string[]>;
    };
  };
};
```

## Phases migration

**Phase 1 : Extraire SDK (semaine 1)**

- Créer `packages/plugin-sdk/`
- Déplacer types stables + helpers
- Publier `@openclaw/plugin-sdk@1.0.0-beta.1`

**Phase 2 : Runtime injection (semaine 2)**

- Créer `src/plugins/plugin-runtime.ts`
- Injecter runtime dans context plugin load
- Migrer 2-3 plugins bundled comme preuve concept

**Phase 3 : Migration masse (semaine 3-4)**

- Migrer tous channels core
- Migrer toutes extensions bundled
- Supprimer imports `src/**` legacy depuis plugins

**Phase 4 : Stabilisation (semaine 5)**

- Tests regression complets
- Docs SDK + exemples
- Publish `@openclaw/plugin-sdk@1.0.0`

## Points contact implémentation

- `packages/plugin-sdk/` : nouveau package
- `src/plugins/plugin-runtime.ts` : injection runtime
- `extensions/*/` : migration tous plugins
- `docs/tools/plugin.md` : docs SDK

Voir aussi :

- [Plugins](/fr-FR/tools/plugin)
- [Création Compétences](/fr-FR/tools/creating-skills)
- [Configuration](/fr-FR/gateway/configuration)
