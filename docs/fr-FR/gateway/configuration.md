---
summary: "Vue d'ensemble de la configuration : tâches courantes, configuration rapide et liens vers la référence complète"
read_when:
  - Configuration d'OpenClaw pour la première fois
  - Recherche de modèles de configuration courants
  - Navigation vers des sections de configuration spécifiques
title: "Configuration"
---

# Configuration

OpenClaw lit une configuration <Tooltip tip="JSON5 supporte les commentaires et les virgules trailing">**JSON5**</Tooltip> optionnelle depuis `~/.openclaw/openclaw.json`.

Si le fichier est manquant, OpenClaw utilise des valeurs par défaut sûres. Raisons courantes d'ajouter une configuration :

- Connecter des canaux et contrôler qui peut envoyer des messages au bot
- Définir les modèles, outils, sandboxing ou automatisation (cron, hooks)
- Ajuster les sessions, médias, réseau ou UI

Voir la [référence complète](/fr-FR/gateway/configuration-reference) pour tous les champs disponibles.

<Tip>
**Nouveau dans la configuration ?** Commencez avec `openclaw onboard` pour une configuration interactive, ou consultez le guide [Exemples de configuration](/fr-FR/gateway/configuration-examples) pour des configurations complètes à copier-coller.
</Tip>

## Configuration minimale

```json5
// ~/.openclaw/openclaw.json
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

## Édition de la configuration

<Tabs>
  <Tab title="Wizard interactif">
    ```bash
    openclaw onboard       # wizard de configuration complète
    openclaw configure     # wizard de configuration
    ```
  </Tab>
  <Tab title="CLI (one-liners)">
    ```bash
    openclaw config get agents.defaults.workspace
    openclaw config set agents.defaults.heartbeat.every "2h"
    openclaw config unset tools.web.search.apiKey
    ```
  </Tab>
  <Tab title="UI de contrôle">
    Ouvrez [http://127.0.0.1:18789](http://127.0.0.1:18789) et utilisez l'onglet **Config**.
    L'UI de contrôle rend un formulaire depuis le schéma de configuration, avec un éditeur **Raw JSON** comme solution de repli.
  </Tab>
  <Tab title="Édition directe">
    Éditez `~/.openclaw/openclaw.json` directement. La passerelle surveille le fichier et applique les changements automatiquement (voir [rechargement à chaud](#rechargement-à-chaud-de-la-configuration)).
  </Tab>
</Tabs>

## Validation stricte

<Warning>
OpenClaw n'accepte que les configurations qui correspondent complètement au schéma. Les clés inconnues, types malformés ou valeurs invalides empêchent la passerelle de **démarrer**. La seule exception au niveau racine est `$schema` (string), pour que les éditeurs puissent attacher des métadonnées JSON Schema.
</Warning>

Quand la validation échoue :

- La passerelle ne démarre pas
- Seules les commandes de diagnostic fonctionnent (`openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`)
- Exécutez `openclaw doctor` pour voir les problèmes exacts
- Exécutez `openclaw doctor --fix` (ou `--yes`) pour appliquer les réparations

## Tâches courantes

<AccordionGroup>
  <Accordion title="Configurer un canal (WhatsApp, Telegram, Discord, etc.)">
    Chaque canal a sa propre section de configuration sous `channels.<provider>`. Voir la page dédiée du canal pour les étapes de configuration :

    - [WhatsApp](/fr-FR/channels/whatsapp) — `channels.whatsapp`
    - [Telegram](/fr-FR/channels/telegram) — `channels.telegram`
    - [Discord](/fr-FR/channels/discord) — `channels.discord`
    - [Slack](/fr-FR/channels/slack) — `channels.slack`
    - [Signal](/fr-FR/channels/signal) — `channels.signal`
    - [iMessage](/fr-FR/channels/imessage) — `channels.imessage`
    - [Google Chat](/fr-FR/channels/googlechat) — `channels.googlechat`
    - [Mattermost](/fr-FR/channels/mattermost) — `channels.mattermost`
    - [MS Teams](/fr-FR/channels/msteams) — `channels.msteams`

    Tous les canaux partagent le même modèle de politique DM :

    ```json5
    {
      channels: {
        telegram: {
          enabled: true,
          botToken: "123:abc",
          dmPolicy: "pairing",   // pairing | allowlist | open | disabled
          allowFrom: ["tg:123"], // seulement pour allowlist/open
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Choisir et configurer les modèles">
    Définissez le modèle principal et les replis optionnels :

    ```json5
    {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-5",
            fallbacks: ["openai/gpt-5.2"],
          },
          models: {
            "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
            "openai/gpt-5.2": { alias: "GPT" },
          },
        },
      },
    }
    ```

    - `agents.defaults.models` définit le catalogue de modèles et agit comme liste blanche pour `/model`.
    - Les références de modèles utilisent le format `provider/model` (ex : `anthropic/claude-opus-4-6`).
    - Voir [CLI Modèles](/fr-FR/concepts/models) pour changer de modèles en chat et [Repli de modèle](/fr-FR/concepts/model-failover) pour la rotation d'auth et le comportement de repli.
    - Pour les fournisseurs personnalisés/auto-hébergés, voir [Fournisseurs personnalisés](/fr-FR/gateway/configuration-reference#fournisseurs-personnalisés-et-urls-de-base) dans la référence.

  </Accordion>

  <Accordion title="Contrôler qui peut envoyer des messages au bot">
    L'accès DM est contrôlé par canal via `dmPolicy` :

    - `"pairing"` (par défaut) : les expéditeurs inconnus reçoivent un code d'appairage unique à approuver
    - `"allowlist"` : seuls les expéditeurs dans `allowFrom` (ou le stockage d'autorisation appairé)
    - `"open"` : autoriser tous les DM entrants (nécessite `allowFrom: ["*"]`)
    - `"disabled"` : ignorer tous les DM

    Pour les groupes, utilisez `groupPolicy` + `groupAllowFrom` ou des listes blanches spécifiques au canal.

    Voir la [référence complète](/fr-FR/gateway/configuration-reference#accès-dm-et-groupe) pour les détails par canal.

  </Accordion>

  <Accordion title="Configurer le gating de mention de chat de groupe">
    Les messages de groupe nécessitent par défaut **une mention**. Configurez les modèles par agent :

    ```json5
    {
      agents: {
        list: [
          {
            id: "main",
            groupChat: {
              mentionPatterns: ["@openclaw", "openclaw"],
            },
          },
        ],
      },
      channels: {
        whatsapp: {
          groups: { "*": { requireMention: true } },
        },
      },
    }
    ```

    - **Mentions de métadonnées** : mentions @- natives (tap-to-mention WhatsApp, @bot Telegram, etc.)
    - **Modèles de texte** : modèles regex dans `mentionPatterns`
    - Voir [référence complète](/fr-FR/gateway/configuration-reference#gating-de-mention-de-chat-de-groupe) pour les overrides par canal et le mode self-chat.

  </Accordion>

  <Accordion title="Configurer les sessions et réinitialisations">
    Les sessions contrôlent la continuité et l'isolation des conversations :

    ```json5
    {
      session: {
        dmScope: "per-channel-peer",  // recommandé pour multi-utilisateur
        reset: {
          mode: "daily",
          atHour: 4,
          idleMinutes: 120,
        },
      },
    }
    ```

    - `dmScope` : `main` (partagé) | `per-peer` | `per-channel-peer` | `per-account-channel-peer`
    - Voir [Gestion des sessions](/fr-FR/concepts/session) pour la portée, les liens d'identité et la politique d'envoi.
    - Voir [référence complète](/fr-FR/gateway/configuration-reference#session) pour tous les champs.

  </Accordion>

  <Accordion title="Activer le sandboxing">
    Exécutez les sessions d'agents dans des conteneurs Docker isolés :

    ```json5
    {
      agents: {
        defaults: {
          sandbox: {
            mode: "non-main",  // off | non-main | all
            scope: "agent",    // session | agent | shared
          },
        },
      },
    }
    ```

    Construisez d'abord l'image : `scripts/sandbox-setup.sh`

    Voir [Sandboxing](/fr-FR/gateway/sandboxing) pour le guide complet et [référence complète](/fr-FR/gateway/configuration-reference#sandbox) pour toutes les options.

  </Accordion>

  <Accordion title="Configurer le heartbeat (check-ins périodiques)">
    ```json5
    {
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            target: "last",
          },
        },
      },
    }
    ```

    - `every` : chaîne de durée (`30m`, `2h`). Définir `0m` pour désactiver.
    - `target` : `last` | `whatsapp` | `telegram` | `discord` | `none`
    - Voir [Heartbeat](/fr-FR/gateway/heartbeat) pour le guide complet.

  </Accordion>

  <Accordion title="Configurer les tâches cron">
    ```json5
    {
      cron: {
        enabled: true,
        maxConcurrentRuns: 2,
        sessionRetention: "24h",
      },
    }
    ```

    Voir [Tâches cron](/fr-FR/automation/cron-jobs) pour la vue d'ensemble de la fonctionnalité et les exemples CLI.

  </Accordion>

  <Accordion title="Configurer les webhooks (hooks)">
    Activez les points de terminaison webhook HTTP sur la passerelle :

    ```json5
    {
      hooks: {
        enabled: true,
        token: "shared-secret",
        path: "/hooks",
        defaultSessionKey: "hook:ingress",
        allowRequestSessionKey: false,
        allowedSessionKeyPrefixes: ["hook:"],
        mappings: [
          {
            match: { path: "gmail" },
            action: "agent",
            agentId: "main",
            deliver: true,
          },
        ],
      },
    }
    ```

    Voir [référence complète](/fr-FR/gateway/configuration-reference#hooks) pour toutes les options de mapping et l'intégration Gmail.

  </Accordion>

  <Accordion title="Configurer le routage multi-agent">
    Exécutez plusieurs agents isolés avec des espaces de travail et sessions séparés :

    ```json5
    {
      agents: {
        list: [
          { id: "home", default: true, workspace: "~/.openclaw/workspace-home" },
          { id: "work", workspace: "~/.openclaw/workspace-work" },
        ],
      },
      bindings: [
        { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
        { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
      ],
    }
    ```

    Voir [Multi-Agent](/fr-FR/concepts/multi-agent) et [référence complète](/fr-FR/gateway/configuration-reference#routage-multi-agent) pour les règles de binding et les profils d'accès par agent.

  </Accordion>

  <Accordion title="Diviser la configuration en plusieurs fichiers ($include)">
    Utilisez `$include` pour organiser les grandes configurations :

    ```json5
    // ~/.openclaw/openclaw.json
    {
      gateway: { port: 18789 },
      agents: { $include: "./agents.json5" },
      broadcast: {
        $include: ["./clients/a.json5", "./clients/b.json5"],
      },
    }
    ```

    - **Fichier unique** : remplace l'objet conteneur
    - **Tableau de fichiers** : fusionné en profondeur dans l'ordre (dernier gagne)
    - **Clés sœurs** : fusionnées après les includes (écrasent les valeurs incluses)
    - **Includes imbriqués** : supportés jusqu'à 10 niveaux de profondeur
    - **Chemins relatifs** : résolus relativement au fichier incluant
    - **Gestion d'erreurs** : erreurs claires pour fichiers manquants, erreurs d'analyse et includes circulaires

  </Accordion>
</AccordionGroup>

## Rechargement à chaud de la configuration

La passerelle surveille `~/.openclaw/openclaw.json` et applique les changements automatiquement — pas besoin de redémarrage manuel pour la plupart des paramètres.

### Modes de rechargement

| Mode                  | Comportement                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **`hybrid`** (défaut) | Applique à chaud les changements sûrs instantanément. Redémarre automatiquement pour les critiques.                             |
| **`hot`**             | Applique à chaud les changements sûrs uniquement. Enregistre un avertissement quand un redémarrage est nécessaire — vous gérez. |
| **`restart`**         | Redémarre la passerelle à chaque changement de configuration, sûr ou non.                                                       |
| **`off`**             | Désactive la surveillance de fichier. Les changements prennent effet au prochain redémarrage manuel.                            |

```json5
{
  gateway: {
    reload: { mode: "hybrid", debounceMs: 300 },
  },
}
```

### Ce qui s'applique à chaud vs ce qui nécessite un redémarrage

La plupart des champs s'appliquent à chaud sans interruption. En mode `hybrid`, les changements nécessitant un redémarrage sont gérés automatiquement.

| Catégorie           | Champs                                                                  | Redémarrage nécessaire ? |
| ------------------- | ----------------------------------------------------------------------- | ------------------------ |
| Canaux              | `channels.*`, `web` (WhatsApp) — tous les canaux intégrés et extensions | Non                      |
| Agent & modèles     | `agent`, `agents`, `models`, `routing`                                  | Non                      |
| Automatisation      | `hooks`, `cron`, `agent.heartbeat`                                      | Non                      |
| Sessions & messages | `session`, `messages`                                                   | Non                      |
| Outils & médias     | `tools`, `browser`, `skills`, `audio`, `talk`                           | Non                      |
| UI & divers         | `ui`, `logging`, `identity`, `bindings`                                 | Non                      |
| Serveur passerelle  | `gateway.*` (port, bind, auth, tailscale, TLS, HTTP)                    | **Oui**                  |
| Infrastructure      | `discovery`, `canvasHost`, `plugins`                                    | **Oui**                  |

<Note>
`gateway.reload` et `gateway.remote` sont des exceptions — les modifier ne déclenche **pas** de redémarrage.
</Note>

## RPC de configuration (mises à jour programmatiques)

<AccordionGroup>
  <Accordion title="config.apply (remplacement complet)">
    Valide + écrit la configuration complète et redémarre la passerelle en une étape.

    <Warning>
    `config.apply` remplace la **configuration entière**. Utilisez `config.patch` pour des mises à jour partielles, ou `openclaw config set` pour des clés uniques.
    </Warning>

    Params :

    - `raw` (string) — payload JSON5 pour la configuration entière
    - `baseHash` (optionnel) — hash de configuration depuis `config.get` (requis quand la config existe)
    - `sessionKey` (optionnel) — clé de session pour le ping de réveil post-redémarrage
    - `note` (optionnel) — note pour la sentinelle de redémarrage
    - `restartDelayMs` (optionnel) — délai avant redémarrage (par défaut 2000)

    ```bash
    openclaw gateway call config.get --params '{}'  # capturer payload.hash
    openclaw gateway call config.apply --params '{
      "raw": "{ agents: { defaults: { workspace: \"~/.openclaw/workspace\" } } }",
      "baseHash": "<hash>",
      "sessionKey": "agent:main:whatsapp:dm:+15555550123"
    }'
    ```

  </Accordion>

  <Accordion title="config.patch (mise à jour partielle)">
    Fusionne une mise à jour partielle dans la configuration existante (sémantique de patch de fusion JSON) :

    - Les objets fusionnent récursivement
    - `null` supprime une clé
    - Les tableaux remplacent

    Params :

    - `raw` (string) — JSON5 avec juste les clés à changer
    - `baseHash` (requis) — hash de configuration depuis `config.get`
    - `sessionKey`, `note`, `restartDelayMs` — identique à `config.apply`

    ```bash
    openclaw gateway call config.patch --params '{
      "raw": "{ channels: { telegram: { groups: { \"*\": { requireMention: false } } } } }",
      "baseHash": "<hash>"
    }'
    ```

  </Accordion>
</AccordionGroup>

## Variables d'environnement

OpenClaw lit les variables d'env depuis le processus parent plus :

- `.env` depuis le répertoire de travail actuel (si présent)
- `~/.openclaw/.env` (repli global)

Aucun fichier n'écrase les variables d'env existantes. Vous pouvez aussi définir des variables d'env inline dans la config :

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

<Accordion title="Import d'env shell (optionnel)">
  Si activé et que les clés attendues ne sont pas définies, OpenClaw exécute votre shell de connexion et importe seulement les clés manquantes :

```json5
{
  env: {
    shellEnv: { enabled: true, timeoutMs: 15000 },
  },
}
```

Équivalent variable d'env : `OPENCLAW_LOAD_SHELL_ENV=1`
</Accordion>

<Accordion title="Substitution de variables d'env dans les valeurs de configuration">
  Référencez les variables d'env dans n'importe quelle valeur de chaîne de configuration avec `${VAR_NAME}` :

```json5
{
  gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
  models: { providers: { custom: { apiKey: "${CUSTOM_API_KEY}" } } },
}
```

Règles :

- Seuls les noms majuscules correspondent : `[A-Z_][A-Z0-9_]*`
- Les variables manquantes/vides génèrent une erreur au moment du chargement
- Échapper avec `$${VAR}` pour la sortie littérale
- Fonctionne dans les fichiers `$include`
- Substitution inline : `"${BASE}/v1"` → `"https://api.example.com/v1"`

</Accordion>

Voir [Environnement](/fr-FR/help/environment) pour la précédence complète et les sources.

## Référence complète

Pour la référence complète champ par champ, voir **[Référence de configuration](/fr-FR/gateway/configuration-reference)**.

---

_Connexe : [Exemples de configuration](/fr-FR/gateway/configuration-examples) · [Référence de configuration](/fr-FR/gateway/configuration-reference) · [Doctor](/fr-FR/gateway/doctor)_
