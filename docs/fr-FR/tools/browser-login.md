---
summary: "Connexions manuelles pour l'automatisation du navigateur + publication sur X/Twitter"
read_when:
  - Vous devez vous connecter à des sites pour l'automatisation du navigateur
  - Vous souhaitez publier des mises à jour sur X/Twitter
title: "Connexion Navigateur"
---

# Connexion navigateur + publication X/Twitter

## Connexion manuelle (recommandé)

Lorsqu'un site nécessite une connexion, **connectez-vous manuellement** dans le profil navigateur **hôte** (le navigateur openclaw).

Ne donnez **pas** vos identifiants au modèle. Les connexions automatisées déclenchent souvent des défenses anti-bot et peuvent verrouiller le compte.

Retour à la documentation principale du navigateur : [Navigateur](/fr-FR/tools/browser).

## Quel profil Chrome est utilisé ?

OpenClaw contrôle un **profil Chrome dédié** (nommé `openclaw`, interface teintée orange). Il est séparé de votre profil de navigateur quotidien.

Deux façons simples d'y accéder :

1. **Demandez à l'agent d'ouvrir le navigateur** puis connectez-vous vous-même.
2. **Ouvrez-le via CLI** :

```bash
openclaw browser start
openclaw browser open https://x.com
```

Si vous avez plusieurs profils, passez `--browser-profile <nom>` (le défaut est `openclaw`).

## X/Twitter : flux recommandé

- **Lecture/recherche/fils** : utilisez le navigateur **hôte** (connexion manuelle).
- **Publier des mises à jour** : utilisez le navigateur **hôte** (connexion manuelle).

## Sandbox + accès navigateur hôte

Les sessions de navigateur en sandbox sont **plus susceptibles** de déclencher la détection de bot. Pour X/Twitter (et autres sites stricts), préférez le navigateur **hôte**.

Si l'agent est en sandbox, l'outil navigateur utilise par défaut le sandbox. Pour autoriser le contrôle de l'hôte :

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Puis ciblez le navigateur hôte :

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

Ou désactivez le sandbox pour l'agent qui publie des mises à jour.
