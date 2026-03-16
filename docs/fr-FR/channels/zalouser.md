---
summary: "Support compte personnel Zalo via zca-cli (connexion QR), capacités et configuration"
read_when:
  - Configuration de Zalo Personnel pour OpenClaw
  - Débogage connexion Zalo Personnel ou flux messages
title: "Zalo Personnel"
---

# Zalo Personnel (non officiel)

Statut : expérimental. Cette intégration automatise un **compte Zalo personnel** via `zca-cli`.

> **Avertissement :** Il s'agit d'une intégration non officielle et peut entraîner une suspension/interdiction de compte. Utilisez à vos propres risques.

## Plugin requis

Zalo Personnel est fourni comme plugin et n'est pas inclus avec l'installation de base.

- Installation via CLI : `openclaw plugins install @openclaw/zalouser`
- Ou depuis un checkout source : `openclaw plugins install ./extensions/zalouser`
- Détails : [Plugins](/fr-FR/tools/plugin)

## Prérequis : zca-cli

La machine Passerelle doit avoir le binaire `zca` disponible dans `PATH`.

- Vérifier : `zca --version`
- Si manquant, installez zca-cli (voir `extensions/zalouser/README.md` ou les docs zca-cli upstream).

## Configuration rapide (débutant)

1. Installez le plugin (voir ci-dessus).
2. Connexion (QR, sur la machine Passerelle) :
   - `openclaw channels login --channel zalouser`
   - Scannez le code QR dans le terminal avec l'app mobile Zalo.
3. Activez le canal :

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

4. Redémarrez la Passerelle (ou terminez l'onboarding).
5. L'accès DM est par défaut en appairage ; approuvez le code d'appairage au premier contact.

## Ce que c'est

- Utilise `zca listen` pour recevoir les messages entrants.
- Utilise `zca msg ...` pour envoyer des réponses (texte/média/lien).
- Conçu pour les cas d'usage "compte personnel" où l'API Bot Zalo n'est pas disponible.

## Nomenclature

L'ID canal est `zalouser` pour rendre explicite que ceci automatise un **compte utilisateur Zalo personnel** (non officiel). Nous gardons `zalo` réservé pour une potentielle future intégration API Zalo officielle.

## Trouver les IDs (annuaire)

Utilisez le CLI annuaire pour découvrir les pairs/groupes et leurs IDs :

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "nom"
openclaw directory groups list --channel zalouser --query "travail"
```

## Limites

- Le texte sortant est découpé à ~2000 caractères (limites client Zalo).
- Le streaming est bloqué par défaut.

## Contrôle d'accès (DM)

`channels.zalouser.dmPolicy` supporte : `pairing | allowlist | open | disabled` (par défaut : `pairing`).
`channels.zalouser.allowFrom` accepte les IDs utilisateur ou noms. L'assistant résout les noms en IDs via `zca friend find` quand disponible.

Approuver via :

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## Accès groupe (optionnel)

- Par défaut : `channels.zalouser.groupPolicy = "open"` (groupes autorisés). Utilisez `channels.defaults.groupPolicy` pour remplacer le défaut quand non défini.
- Restreindre à une allowlist avec :
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (les clés sont des IDs ou noms de groupe)
- Bloquer tous les groupes : `channels.zalouser.groupPolicy = "disabled"`.
- L'assistant de configuration peut demander les allowlists de groupe.
- Au démarrage, OpenClaw résout les noms groupe/utilisateur dans les allowlists en IDs et enregistre le mappage ; les entrées non résolues sont conservées telles qu'elles ont été saisies.

Exemple :

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Chat Travail": { allow: true },
      },
    },
  },
}
```

## Multi-comptes

Les comptes mappent aux profils zca. Exemple :

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## Dépannage

**`zca` introuvable :**

- Installez zca-cli et assurez-vous qu'il est sur `PATH` pour le processus Passerelle.

**La connexion ne persiste pas :**

- `openclaw channels status --probe`
- Reconnexion : `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`

## Voir aussi

- [Plugins](/fr-FR/tools/plugin)
- [Configuration de la Passerelle](/fr-FR/gateway/configuration)
- [Appairage](/fr-FR/channels/pairing)
