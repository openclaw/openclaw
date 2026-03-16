---
summary: "Installez OpenClaw et lancez votre première conversation en quelques minutes."
read_when:
  - Configuration initiale depuis zéro
  - Vous voulez le chemin le plus rapide vers une conversation fonctionnelle
title: "Premiers pas"
---

# Premiers pas

Objectif : passer de zéro à une première conversation fonctionnelle avec une configuration minimale.

<Info>
Conversation la plus rapide : ouvrez l'Interface de contrôle (aucune configuration de canal nécessaire). Lancez `openclaw dashboard` et discutez dans le navigateur, ou ouvrez `http://127.0.0.1:18789/` sur l'<Tooltip headline="Hôte passerelle" tip="La machine qui exécute le service de passerelle OpenClaw.">hôte passerelle</Tooltip>.
Docs : [Tableau de bord](/fr-FR/web/dashboard) et [Interface de contrôle](/fr-FR/web/control-ui).
</Info>

## Prérequis

- Node 22 ou plus récent

<Tip>
Vérifiez votre version de Node avec `node --version` si vous n'êtes pas sûr.
</Tip>

## Configuration rapide (CLI)

<Steps>
  <Step title="Installer OpenClaw (recommandé)">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
        <img
  src="/assets/install-script.svg"
  alt="Processus du script d'installation"
  className="rounded-lg"
/>
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    Autres méthodes d'installation et exigences : [Installation](/fr-FR/install/index).
    </Note>

  </Step>
  <Step title="Lancer l'assistant de configuration">
    ```bash
    openclaw onboard --install-daemon
    ```

    L'assistant configure l'authentification, les paramètres de la passerelle et les canaux optionnels.
    Voir [Assistant de configuration](/fr-FR/start/wizard) pour les détails.

  </Step>
  <Step title="Vérifier la Passerelle">
    Si vous avez installé le service, il devrait déjà être en cours d'exécution :

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Ouvrir l'Interface de contrôle">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
Si l'Interface de contrôle se charge, votre Passerelle est prête à l'emploi.
</Check>

## Vérifications optionnelles et extras

<AccordionGroup>
  <Accordion title="Exécuter la Passerelle au premier plan">
    Utile pour des tests rapides ou le dépannage.

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="Envoyer un message de test">
    Nécessite un canal configuré.

    ```bash
    openclaw message send --target +15555550123 --message "Bonjour depuis OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## Variables d'environnement utiles

Si vous exécutez OpenClaw en tant que compte de service ou souhaitez des emplacements personnalisés pour la config/l'état :

- `OPENCLAW_HOME` définit le répertoire d'accueil utilisé pour la résolution des chemins internes.
- `OPENCLAW_STATE_DIR` remplace le répertoire d'état.
- `OPENCLAW_CONFIG_PATH` remplace le chemin du fichier de configuration.

Référence complète des variables d'environnement : [Variables d'environnement](/fr-FR/help/environment).

## Aller plus loin

<Columns>
  <Card title="Assistant de configuration (détails)" href="/fr-FR/start/wizard">
    Référence complète de l'assistant CLI et options avancées.
  </Card>
  <Card title="Configuration initiale de l'app macOS" href="/fr-FR/start/onboarding">
    Flux de première exécution pour l'application macOS.
  </Card>
</Columns>

## Ce que vous aurez

- Une Passerelle en cours d'exécution
- Authentification configurée
- Accès à l'Interface de contrôle ou un canal connecté

## Étapes suivantes

- Sécurité des DM et approbations : [Appairage](/fr-FR/channels/pairing)
- Connecter plus de canaux : [Canaux](/fr-FR/channels/index)
- Workflows avancés et installation depuis les sources : [Configuration](/fr-FR/start/setup)
