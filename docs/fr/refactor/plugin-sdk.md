---
summary: "Plan : un SDK de plugins propre et un runtime pour tous les connecteurs de messagerie"
read_when:
  - Definition ou refactorisation de l’architecture des plugins
  - Migration des connecteurs de canal vers le SDK/runtime de plugins
title: "Refactorisation du SDK de plugins"
---

# Plan de refactorisation du SDK de plugins + runtime

Objectif : chaque connecteur de messagerie est un plugin (regroupe ou externe) utilisant une API stable unique.
Aucun plugin n’importe directement `src/**`. Toutes les dependances passent par le SDK ou le runtime.

## Pourquoi maintenant

- Les connecteurs actuels melangent les approches : imports directs du core, ponts dist-only et helpers personnalises.
- Cela rend les mises a niveau fragiles et bloque une surface de plugins externes propre.

## Architecture cible (deux couches)

### 1. SDK de plugins (temps de compilation, stable, publiable)

Portee : types, helpers et utilitaires de configuration. Aucun etat d’execution, aucun effet de bord.

Contenu (exemples) :

- Types : `ChannelPlugin`, adaptateurs, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.
- Helpers de configuration : `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,
  `applyAccountNameToChannelSection`.
- Helpers d’appairage : `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.
- Helpers de prise en main : `promptChannelAccessConfig`, `addWildcardAllowFrom`, types d’onboarding.
- Helpers de parametres d’outils : `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.
- Helper de lien vers la documentation : `formatDocsLink`.

Livraison:

- Publie en tant que `openclaw/plugin-sdk` (ou exporte depuis le core sous `openclaw/plugin-sdk`).
- Semver avec garanties de stabilite explicites.

### 2. Runtime de plugins (surface d’execution, injecte)

Portee : tout ce qui touche au comportement du runtime du core.
Accessible via `OpenClawPluginApi.runtime` afin que les plugins n’importent jamais `src/**`.

Surface proposee (minimale mais complete) :

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

Notes :

- Le runtime est l’unique moyen d’acceder au comportement du core.
- Le SDK est volontairement petit et stable.
- Chaque methode du runtime correspond a une implementation existante du core (pas de duplication).

## Plan de migration (progressif, sur)

### Phase 0 : echafaudage

- Introduire `openclaw/plugin-sdk`.
- Ajouter `api.runtime` a `OpenClawPluginApi` avec la surface ci-dessus.
- Maintenir les imports existants pendant une fenetre de transition (avertissements de deprecation).

### Phase 1 : nettoyage des ponts (faible risque)

- Remplacer les `core-bridge.ts` par extension par `api.runtime`.
- Migrer BlueBubbles, Zalo, Zalo Personal en premier (deja proches).
- Supprimer le code de pont duplique.

### Phase 2 : plugins a imports directs legers

- Migrer Matrix vers le SDK + runtime.
- Valider la prise en main, le repertoire et la logique de mention de groupe.

### Phase 3 : plugins a imports directs lourds

- Migrer MS Teams (plus grand ensemble de helpers runtime).
- Verifier que les semantiques de reponse et de saisie correspondent au comportement actuel.

### Phase 4 : pluginisation d’iMessage

- Deplacer iMessage dans `extensions/imessage`.
- Remplacer les appels directs au core par `api.runtime`.
- Conserver les cles de configuration, le comportement de la CLI et la documentation intacts.

### Phase 5 : application des regles

- Ajouter une regle de lint / verification CI : aucun import `extensions/**` depuis `src/**`.
- Ajouter des verifications de compatibilite SDK/version de plugins (runtime + semver du SDK).

## Compatibilite et versionnage

- SDK : semver, publie, changements documentes.
- Runtime : versionne par version du core. Ajouter `api.runtime.version`.
- Les plugins declarent une plage de runtime requise (p. ex., `openclawRuntime: ">=2026.2.0"`).

## Strategie de tests

- Tests unitaires au niveau des adaptateurs (fonctions du runtime exercees avec une implementation reelle du core).
- Tests « golden » par plugin : s’assurer de l’absence de derive comportementale (routage, appairage, allowlist, filtrage des mentions).
- Un unique exemple de plugin de bout en bout utilise en CI (installation + execution + smoke).

## Questions ouvertes

- Ou heberger les types du SDK : package separe ou export du core ?
- Distribution des types du runtime : dans le SDK (types uniquement) ou dans le core ?
- Comment exposer les liens de documentation pour les plugins regroupes vs externes ?
- Autorise-t-on des imports directs limites du core pour les plugins en depot pendant la transition ?

## Critères de succès

- Tous les connecteurs de canal sont des plugins utilisant le SDK + runtime.
- Aucun import `extensions/**` depuis `src/**`.
- Les nouveaux modeles de connecteurs ne dependent que du SDK + runtime.
- Les plugins externes peuvent etre developpes et mis a jour sans acces au code source du core.

Documents connexes : [Plugins](/plugin), [Channels](/channels/index), [Configuration](/gateway/configuration).
