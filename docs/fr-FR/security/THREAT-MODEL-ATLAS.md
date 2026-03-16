# Modèle de menaces OpenClaw v1.0

## Framework MITRE ATLAS

**Version :** 1.0-draft
**Dernière mise à jour :** 2026-02-04
**Méthodologie :** MITRE ATLAS + Diagrammes de flux de données
**Framework :** [MITRE ATLAS](https://atlas.mitre.org/) (Adversarial Threat Landscape for AI Systems)

### Attribution du framework

Ce modèle de menaces est construit sur [MITRE ATLAS](https://atlas.mitre.org/), le framework standard de l'industrie pour documenter les menaces adverses aux systèmes AI/ML. ATLAS est maintenu par [MITRE](https://www.mitre.org/) en collaboration avec la communauté de sécurité AI.

**Ressources ATLAS clés :**

- [Techniques ATLAS](https://atlas.mitre.org/techniques/)
- [Tactiques ATLAS](https://atlas.mitre.org/tactics/)
- [Études de cas ATLAS](https://atlas.mitre.org/studies/)
- [GitHub ATLAS](https://github.com/mitre-atlas/atlas-data)
- [Contribuer à ATLAS](https://atlas.mitre.org/resources/contribute)

### Contribuer à ce modèle de menaces

Ceci est un document vivant maintenu par la communauté OpenClaw. Voir [CONTRIBUTING-THREAT-MODEL.md](./CONTRIBUTING-THREAT-MODEL.md) pour les directives de contribution :

- Signaler de nouvelles menaces
- Mettre à jour les menaces existantes
- Proposer des chaînes d'attaque
- Suggérer des atténuations

---

## 1. Introduction

### 1.1 Objectif

Ce modèle de menaces documente les menaces adverses à la plateforme d'agent AI OpenClaw et au marketplace de compétences ClawHub, en utilisant le framework MITRE ATLAS conçu spécifiquement pour les systèmes AI/ML.

### 1.2 Portée

| Composant                | Inclus  | Notes                                                      |
| ------------------------ | ------- | ---------------------------------------------------------- |
| Runtime d'agent OpenClaw | Oui     | Exécution principale de l'agent, appels d'outils, sessions |
| Passerelle               | Oui     | Authentification, routage, intégration des canaux          |
| Intégrations de canaux   | Oui     | WhatsApp, Telegram, Discord, Signal, Slack, etc.           |
| Marketplace ClawHub      | Oui     | Publication, modération, distribution de compétences       |
| Serveurs MCP             | Oui     | Fournisseurs d'outils externes                             |
| Appareils utilisateurs   | Partiel | Apps mobiles, clients desktop                              |

### 1.3 Hors portée

Rien n'est explicitement hors portée pour ce modèle de menaces.

---

## 2. Architecture système

### 2.1 Frontières de confiance

```
┌─────────────────────────────────────────────────────────────────┐
│                    ZONE NON FIABLE                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  WhatsApp   │  │  Telegram   │  │   Discord   │  ...         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
└─────────┼────────────────┼────────────────┼──────────────────────┘
          │                │                │
          ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────┐
│              FRONTIÈRE DE CONFIANCE 1: Accès canal               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                     PASSERELLE                            │   │
│  │  • Appairage d'appareil (période de grâce 30s)           │   │
│  │  • Validation AllowFrom / AllowList                       │   │
│  │  • Authentification Token/Mot de passe/Tailscale         │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              FRONTIÈRE DE CONFIANCE 2: Isolation de session      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   SESSIONS D'AGENT                        │   │
│  │  • Clé de session = agent:canal:pair                      │   │
│  │  • Politiques d'outils par agent                          │   │
│  │  • Journalisation des transcriptions                      │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              FRONTIÈRE DE CONFIANCE 3: Exécution d'outils        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                 SANDBOX D'EXÉCUTION                       │   │
│  │  • Sandbox Docker OU Hôte (exec-approvals)                │   │
│  │  • Exécution distante de nœud                             │   │
│  │  • Protection SSRF (épinglage DNS + blocage IP)           │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              FRONTIÈRE DE CONFIANCE 4: Contenu externe           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │           URLs / E-MAILS / WEBHOOKS RÉCUPÉRÉS            │   │
│  │  • Enveloppement de contenu externe (balises XML)        │   │
│  │  • Injection d'avertissement de sécurité                 │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              FRONTIÈRE DE CONFIANCE 5: Chaîne d'approvisionnement│
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                      CLAWHUB                              │   │
│  │  • Publication de compétences (semver, SKILL.md requis)   │   │
│  │  • Flags de modération basés sur motifs                  │   │
│  │  • Scan VirusTotal (à venir)                             │   │
│  │  • Vérification de l'âge du compte GitHub                │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Flux de données

| Flux | Source     | Destination | Données              | Protection               |
| ---- | ---------- | ----------- | -------------------- | ------------------------ |
| F1   | Canal      | Passerelle  | Messages utilisateur | TLS, AllowFrom           |
| F2   | Passerelle | Agent       | Messages routés      | Isolation de session     |
| F3   | Agent      | Outils      | Invocations d'outils | Application de politique |
| F4   | Agent      | Externe     | Requêtes web_fetch   | Blocage SSRF             |
| F5   | ClawHub    | Agent       | Code de compétence   | Modération, scan         |
| F6   | Agent      | Canal       | Réponses             | Filtrage de sortie       |

---

## 3. Analyse des menaces par tactique ATLAS

### 3.1 Reconnaissance (AML.TA0002)

#### T-RECON-001: Découverte de point de terminaison d'agent

| Attribut                   | Valeur                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **ID ATLAS**               | AML.T0006 - Scan actif                                                                                         |
| **Description**            | L'attaquant scanne pour trouver les points de terminaison de passerelle OpenClaw exposés                       |
| **Vecteur d'attaque**      | Scan réseau, requêtes shodan, énumération DNS                                                                  |
| **Composants affectés**    | Passerelle, points de terminaison API exposés                                                                  |
| **Atténuations actuelles** | Option d'auth Tailscale, liaison à loopback par défaut                                                         |
| **Risque résiduel**        | Moyen - Passerelles publiques découvrables                                                                     |
| **Recommandations**        | Documenter le déploiement sécurisé, ajouter la limitation de débit sur les points de terminaison de découverte |

#### T-RECON-002: Sondage d'intégration de canal

| Attribut                   | Valeur                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------- |
| **ID ATLAS**               | AML.T0006 - Scan actif                                                              |
| **Description**            | L'attaquant sonde les canaux de messagerie pour identifier les comptes gérés par AI |
| **Vecteur d'attaque**      | Envoi de messages de test, observation des motifs de réponse                        |
| **Composants affectés**    | Toutes les intégrations de canaux                                                   |
| **Atténuations actuelles** | Aucune spécifique                                                                   |
| **Risque résiduel**        | Faible - Valeur limitée de la découverte seule                                      |
| **Recommandations**        | Considérer la randomisation du timing de réponse                                    |

---

### 3.2 Accès initial (AML.TA0004)

#### T-ACCESS-001: Interception de code d'appairage

| Attribut                   | Valeur                                                                        |
| -------------------------- | ----------------------------------------------------------------------------- |
| **ID ATLAS**               | AML.T0040 - Accès API d'inférence de modèle AI                                |
| **Description**            | L'attaquant intercepte le code d'appairage pendant la période de grâce de 30s |
| **Vecteur d'attaque**      | Surf d'épaule, reniflage réseau, ingénierie sociale                           |
| **Composants affectés**    | Système d'appairage d'appareil                                                |
| **Atténuations actuelles** | Expiration 30s, codes envoyés via canal existant                              |
| **Risque résiduel**        | Moyen - Période de grâce exploitable                                          |
| **Recommandations**        | Réduire la période de grâce, ajouter une étape de confirmation                |

#### T-ACCESS-002: Usurpation AllowFrom

| Attribut                   | Valeur                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| **ID ATLAS**               | AML.T0040 - Accès API d'inférence de modèle AI                                                      |
| **Description**            | L'attaquant usurpe l'identité de l'expéditeur autorisé dans le canal                                |
| **Vecteur d'attaque**      | Dépend du canal - usurpation de numéro de téléphone, usurpation de nom d'utilisateur                |
| **Composants affectés**    | Validation AllowFrom par canal                                                                      |
| **Atténuations actuelles** | Vérification d'identité spécifique au canal                                                         |
| **Risque résiduel**        | Moyen - Certains canaux vulnérables à l'usurpation                                                  |
| **Recommandations**        | Documenter les risques spécifiques aux canaux, ajouter une vérification cryptographique si possible |

#### T-ACCESS-003: Vol de token

| Attribut                   | Valeur                                                                       |
| -------------------------- | ---------------------------------------------------------------------------- |
| **ID ATLAS**               | AML.T0040 - Accès API d'inférence de modèle AI                               |
| **Description**            | L'attaquant vole les tokens d'authentification des fichiers de config        |
| **Vecteur d'attaque**      | Malware, accès non autorisé à l'appareil, exposition de sauvegarde de config |
| **Composants affectés**    | ~/.openclaw/credentials/, stockage de config                                 |
| **Atténuations actuelles** | Permissions de fichiers                                                      |
| **Risque résiduel**        | Élevé - Tokens stockés en texte clair                                        |
| **Recommandations**        | Implémenter le chiffrement de token au repos, ajouter la rotation de token   |

---

### 3.3 Exécution (AML.TA0005)

#### T-EXEC-001: Injection d'invite directe

| Attribut                   | Valeur                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **ID ATLAS**               | AML.T0051.000 - Injection d'invite LLM : Directe                                                                 |
| **Description**            | L'attaquant envoie des invites conçues pour manipuler le comportement de l'agent                                 |
| **Vecteur d'attaque**      | Messages de canal contenant des instructions adverses                                                            |
| **Composants affectés**    | LLM d'agent, toutes les surfaces d'entrée                                                                        |
| **Atténuations actuelles** | Détection de motifs, enveloppement de contenu externe                                                            |
| **Risque résiduel**        | Critique - Détection uniquement, pas de blocage ; les attaques sophistiquées contournent                         |
| **Recommandations**        | Implémenter une défense multi-couches, validation de sortie, confirmation utilisateur pour les actions sensibles |

#### T-EXEC-002: Injection d'invite indirecte

| Attribut                   | Valeur                                                                        |
| -------------------------- | ----------------------------------------------------------------------------- |
| **ID ATLAS**               | AML.T0051.001 - Injection d'invite LLM : Indirecte                            |
| **Description**            | L'attaquant incorpore des instructions malveillantes dans le contenu récupéré |
| **Vecteur d'attaque**      | URLs malveillantes, e-mails empoisonnés, webhooks compromis                   |
| **Composants affectés**    | web_fetch, ingestion d'e-mails, sources de données externes                   |
| **Atténuations actuelles** | Enveloppement de contenu avec balises XML et avertissement de sécurité        |
| **Risque résiduel**        | Élevé - Le LLM peut ignorer les instructions d'enveloppe                      |
| **Recommandations**        | Implémenter la sanitisation de contenu, contextes d'exécution séparés         |

#### T-EXEC-003: Injection d'argument d'outil

| Attribut                   | Valeur                                                              |
| -------------------------- | ------------------------------------------------------------------- |
| **ID ATLAS**               | AML.T0051.000 - Injection d'invite LLM : Directe                    |
| **Description**            | L'attaquant manipule les arguments d'outil via l'injection d'invite |
| **Vecteur d'attaque**      | Invites conçues qui influencent les valeurs de paramètres d'outil   |
| **Composants affectés**    | Toutes les invocations d'outils                                     |
| **Atténuations actuelles** | Approbations exec pour les commandes dangereuses                    |
| **Risque résiduel**        | Élevé - Repose sur le jugement de l'utilisateur                     |
| **Recommandations**        | Implémenter la validation d'arguments, appels d'outils paramétrés   |

#### T-EXEC-004: Contournement d'approbation exec

| Attribut                   | Valeur                                                                        |
| -------------------------- | ----------------------------------------------------------------------------- |
| **ID ATLAS**               | AML.T0043 - Créer des données adverses                                        |
| **Description**            | L'attaquant crée des commandes qui contournent la liste blanche d'approbation |
| **Vecteur d'attaque**      | Obfuscation de commande, exploitation d'alias, manipulation de chemin         |
| **Composants affectés**    | exec-approvals.ts, liste blanche de commandes                                 |
| **Atténuations actuelles** | Liste blanche + mode demande                                                  |
| **Risque résiduel**        | Élevé - Pas de sanitisation de commande                                       |
| **Recommandations**        | Implémenter la normalisation de commande, étendre la liste noire              |

---

### 3.4 Persistance (AML.TA0006)

#### T-PERSIST-001: Installation de compétence malveillante

| Attribut                   | Valeur                                                                        |
| -------------------------- | ----------------------------------------------------------------------------- |
| **ID ATLAS**               | AML.T0010.001 - Compromis de chaîne d'approvisionnement : Logiciel AI         |
| **Description**            | L'attaquant publie une compétence malveillante sur ClawHub                    |
| **Vecteur d'attaque**      | Créer un compte, publier une compétence avec du code malveillant caché        |
| **Composants affectés**    | ClawHub, chargement de compétence, exécution d'agent                          |
| **Atténuations actuelles** | Vérification de l'âge du compte GitHub, flags de modération basés sur motifs  |
| **Risque résiduel**        | Critique - Pas de sandbox, revue limitée                                      |
| **Recommandations**        | Intégration VirusTotal (en cours), sandbox de compétence, revue communautaire |

#### T-PERSIST-002: Empoisonnement de mise à jour de compétence

| Attribut                   | Valeur                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------- |
| **ID ATLAS**               | AML.T0010.001 - Compromis de chaîne d'approvisionnement : Logiciel AI                 |
| **Description**            | L'attaquant compromet une compétence populaire et pousse une mise à jour malveillante |
| **Vecteur d'attaque**      | Compromis de compte, ingénierie sociale du propriétaire de compétence                 |
| **Composants affectés**    | Versioning ClawHub, flux de mise à jour automatique                                   |
| **Atténuations actuelles** | Empreinte de version                                                                  |
| **Risque résiduel**        | Élevé - Les mises à jour automatiques peuvent tirer des versions malveillantes        |
| **Recommandations**        | Implémenter la signature de mise à jour, capacité de rollback, épinglage de version   |

#### T-PERSIST-003: Manipulation de configuration d'agent

| Attribut                   | Valeur                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| **ID ATLAS**               | AML.T0010.002 - Compromis de chaîne d'approvisionnement : Données                         |
| **Description**            | L'attaquant modifie la configuration de l'agent pour persister l'accès                    |
| **Vecteur d'attaque**      | Modification de fichier de config, injection de paramètres                                |
| **Composants affectés**    | Config d'agent, politiques d'outils                                                       |
| **Atténuations actuelles** | Permissions de fichiers                                                                   |
| **Risque résiduel**        | Moyen - Nécessite un accès local                                                          |
| **Recommandations**        | Vérification d'intégrité de config, journalisation d'audit pour les changements de config |

---

### 3.5 Évasion de défense (AML.TA0007)

#### T-EVADE-001: Contournement de motif de modération

| Attribut                   | Valeur                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------ |
| **ID ATLAS**               | AML.T0043 - Créer des données adverses                                               |
| **Description**            | L'attaquant crée du contenu de compétence pour éviter les motifs de modération       |
| **Vecteur d'attaque**      | Homoglyphes Unicode, astuces d'encodage, chargement dynamique                        |
| **Composants affectés**    | ClawHub moderation.ts                                                                |
| **Atténuations actuelles** | FLAG_RULES basés sur motifs                                                          |
| **Risque résiduel**        | Élevé - Regex simple facilement contourné                                            |
| **Recommandations**        | Ajouter l'analyse comportementale (VirusTotal Code Insight), détection basée sur AST |

#### T-EVADE-002: Échappement d'enveloppe de contenu

| Attribut                   | Valeur                                                                     |
| -------------------------- | -------------------------------------------------------------------------- |
| **ID ATLAS**               | AML.T0043 - Créer des données adverses                                     |
| **Description**            | L'attaquant crée du contenu qui échappe au contexte d'enveloppe XML        |
| **Vecteur d'attaque**      | Manipulation de balises, confusion de contexte, remplacement d'instruction |
| **Composants affectés**    | Enveloppement de contenu externe                                           |
| **Atténuations actuelles** | Balises XML + avertissement de sécurité                                    |
| **Risque résiduel**        | Moyen - De nouvelles échappées découvertes régulièrement                   |
| **Recommandations**        | Couches d'enveloppe multiples, validation côté sortie                      |

---

### 3.6 Découverte (AML.TA0008)

#### T-DISC-001: Énumération d'outils

| Attribut                   | Valeur                                                  |
| -------------------------- | ------------------------------------------------------- |
| **ID ATLAS**               | AML.T0040 - Accès API d'inférence de modèle AI          |
| **Description**            | L'attaquant énumère les outils disponibles via l'invite |
| **Vecteur d'attaque**      | Requêtes de style "Quels outils as-tu ?"                |
| **Composants affectés**    | Registre d'outils d'agent                               |
| **Atténuations actuelles** | Aucune spécifique                                       |
| **Risque résiduel**        | Faible - Outils généralement documentés                 |
| **Recommandations**        | Considérer les contrôles de visibilité des outils       |

#### T-DISC-002: Extraction de données de session

| Attribut                   | Valeur                                                           |
| -------------------------- | ---------------------------------------------------------------- |
| **ID ATLAS**               | AML.T0040 - Accès API d'inférence de modèle AI                   |
| **Description**            | L'attaquant extrait des données sensibles du contexte de session |
| **Vecteur d'attaque**      | Requêtes "De quoi avons-nous discuté ?", sondage de contexte     |
| **Composants affectés**    | Transcriptions de session, fenêtre de contexte                   |
| **Atténuations actuelles** | Isolation de session par expéditeur                              |
| **Risque résiduel**        | Moyen - Données intra-session accessibles                        |
| **Recommandations**        | Implémenter la rédaction de données sensibles dans le contexte   |

---

### 3.7 Collection & Exfiltration (AML.TA0009, AML.TA0010)

#### T-EXFIL-001: Vol de données via web_fetch

| Attribut                   | Valeur                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| **ID ATLAS**               | AML.T0009 - Collection                                                                   |
| **Description**            | L'attaquant exfiltre des données en instruisant l'agent d'envoyer vers une URL externe   |
| **Vecteur d'attaque**      | Injection d'invite causant l'envoi POST de données par l'agent vers un serveur attaquant |
| **Composants affectés**    | Outil web_fetch                                                                          |
| **Atténuations actuelles** | Blocage SSRF pour les réseaux internes                                                   |
| **Risque résiduel**        | Élevé - URLs externes autorisées                                                         |
| **Recommandations**        | Implémenter la liste blanche d'URL, sensibilisation à la classification de données       |

#### T-EXFIL-002: Envoi de message non autorisé

| Attribut                   | Valeur                                                                            |
| -------------------------- | --------------------------------------------------------------------------------- |
| **ID ATLAS**               | AML.T0009 - Collection                                                            |
| **Description**            | L'attaquant fait envoyer par l'agent des messages contenant des données sensibles |
| **Vecteur d'attaque**      | Injection d'invite causant l'envoi de message à l'attaquant par l'agent           |
| **Composants affectés**    | Outil de message, intégrations de canaux                                          |
| **Atténuations actuelles** | Gating de messagerie sortante                                                     |
| **Risque résiduel**        | Moyen - Le gating peut être contourné                                             |
| **Recommandations**        | Exiger une confirmation explicite pour les nouveaux destinataires                 |

#### T-EXFIL-003: Récolte d'identifiants

| Attribut                   | Valeur                                                                      |
| -------------------------- | --------------------------------------------------------------------------- |
| **ID ATLAS**               | AML.T0009 - Collection                                                      |
| **Description**            | La compétence malveillante récolte des identifiants du contexte d'agent     |
| **Vecteur d'attaque**      | Le code de compétence lit les variables d'environnement, fichiers de config |
| **Composants affectés**    | Environnement d'exécution de compétence                                     |
| **Atténuations actuelles** | Aucune spécifique aux compétences                                           |
| **Risque résiduel**        | Critique - Les compétences s'exécutent avec les privilèges d'agent          |
| **Recommandations**        | Sandbox de compétence, isolation des identifiants                           |

---

### 3.8 Impact (AML.TA0011)

#### T-IMPACT-001: Exécution de commande non autorisée

| Attribut                   | Valeur                                                                   |
| -------------------------- | ------------------------------------------------------------------------ |
| **ID ATLAS**               | AML.T0031 - Éroder l'intégrité du modèle AI                              |
| **Description**            | L'attaquant exécute des commandes arbitraires sur le système utilisateur |
| **Vecteur d'attaque**      | Injection d'invite combinée avec contournement d'approbation exec        |
| **Composants affectés**    | Outil Bash, exécution de commande                                        |
| **Atténuations actuelles** | Approbations exec, option sandbox Docker                                 |
| **Risque résiduel**        | Critique - Exécution hôte sans sandbox                                   |
| **Recommandations**        | Par défaut vers sandbox, améliorer l'UX d'approbation                    |

#### T-IMPACT-002: Épuisement de ressources (DoS)

| Attribut                   | Valeur                                                           |
| -------------------------- | ---------------------------------------------------------------- |
| **ID ATLAS**               | AML.T0031 - Éroder l'intégrité du modèle AI                      |
| **Description**            | L'attaquant épuise les crédits API ou ressources de calcul       |
| **Vecteur d'attaque**      | Inondation automatisée de messages, appels d'outils coûteux      |
| **Composants affectés**    | Passerelle, sessions d'agent, fournisseur API                    |
| **Atténuations actuelles** | Aucune                                                           |
| **Risque résiduel**        | Élevé - Pas de limitation de débit                               |
| **Recommandations**        | Implémenter des limites de débit par expéditeur, budgets de coût |

#### T-IMPACT-003: Dommage à la réputation

| Attribut                   | Valeur                                                             |
| -------------------------- | ------------------------------------------------------------------ |
| **ID ATLAS**               | AML.T0031 - Éroder l'intégrité du modèle AI                        |
| **Description**            | L'attaquant fait envoyer du contenu nuisible/offensant par l'agent |
| **Vecteur d'attaque**      | Injection d'invite causant des réponses inappropriées              |
| **Composants affectés**    | Génération de sortie, messagerie de canal                          |
| **Atténuations actuelles** | Politiques de contenu du fournisseur LLM                           |
| **Risque résiduel**        | Moyen - Filtres du fournisseur imparfaits                          |
| **Recommandations**        | Couche de filtrage de sortie, contrôles utilisateur                |

---

## 4. Analyse de la chaîne d'approvisionnement ClawHub

### 4.1 Contrôles de sécurité actuels

| Contrôle                      | Implémentation                | Efficacité                                                                 |
| ----------------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| Âge du compte GitHub          | `requireGitHubAccountAge()`   | Moyen - Élève la barre pour les nouveaux attaquants                        |
| Sanitisation de chemin        | `sanitizePath()`              | Élevé - Prévient la traversée de chemin                                    |
| Validation de type de fichier | `isTextFile()`                | Moyen - Fichiers texte uniquement, mais peuvent toujours être malveillants |
| Limites de taille             | Bundle total 50MB             | Élevé - Prévient l'épuisement de ressources                                |
| SKILL.md requis               | Readme obligatoire            | Faible valeur de sécurité - Informatif uniquement                          |
| Modération de motifs          | FLAG_RULES dans moderation.ts | Faible - Facilement contourné                                              |
| Statut de modération          | Champ `moderationStatus`      | Moyen - Revue manuelle possible                                            |

### 4.2 Motifs de flag de modération

Motifs actuels dans `moderation.ts` :

```javascript
// Identifiants connus comme mauvais
/(keepcold131\/ClawdAuthenticatorTool|ClawdAuthenticatorTool)/i

// Mots-clés suspects
/(malware|stealer|phish|phishing|keylogger)/i
/(api[-_ ]?key|token|password|private key|secret)/i
/(wallet|seed phrase|mnemonic|crypto)/i
/(discord\.gg|webhook|hooks\.slack)/i
/(curl[^\n]+\|\s*(sh|bash))/i
/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd)/i
```

**Limitations :**

- Vérifie uniquement slug, displayName, summary, frontmatter, metadata, chemins de fichiers
- N'analyse pas le contenu réel du code de compétence
- Regex simple facilement contourné avec obfuscation
- Pas d'analyse comportementale

### 4.3 Améliorations planifiées

| Amélioration           | Statut    | Impact                                         |
| ---------------------- | --------- | ---------------------------------------------- |
| Intégration VirusTotal | En cours  | Élevé - Analyse comportementale Code Insight   |
| Sandbox de compétence  | Planifié  | Critique - Isoler l'exécution de compétence    |
| Revue communautaire    | Planifié  | Moyen - Signal de crowdsourcing                |
| Signature de code      | Considéré | Élevé - Vérifier l'intégrité et l'authenticité |

---

**Note :** Ce modèle de menaces est un document vivant. Voir [CONTRIBUTING-THREAT-MODEL.md](./CONTRIBUTING-THREAT-MODEL.md) pour contribuer.
