# Contribuer au modèle de menaces OpenClaw

Merci d'aider à rendre OpenClaw plus sécurisé. Ce modèle de menaces est un document vivant et nous accueillons les contributions de tout le monde - vous n'avez pas besoin d'être un expert en sécurité.

## Façons de contribuer

### Ajouter une menace

Vous avez repéré un vecteur d'attaque ou un risque que nous n'avons pas couvert ? Ouvrez une issue sur [openclaw/trust](https://github.com/openclaw/trust/issues) et décrivez-le avec vos propres mots. Vous n'avez pas besoin de connaître des frameworks ou de remplir chaque champ - décrivez simplement le scénario.

**Utile à inclure (mais pas requis) :**

- Le scénario d'attaque et comment il pourrait être exploité
- Quelles parties d'OpenClaw sont affectées (CLI, passerelle, canaux, ClawHub, serveurs MCP, etc.)
- À quel point vous pensez que c'est sévère (faible / moyen / élevé / critique)
- Tous liens vers des recherches connexes, CVEs, ou exemples du monde réel

Nous gérerons le mappage ATLAS, les IDs de menace, et l'évaluation des risques pendant la revue. Si vous voulez inclure ces détails, parfait - mais ce n'est pas attendu.

> **Ceci est pour ajouter au modèle de menaces, pas pour signaler des vulnérabilités actives.** Si vous avez trouvé une vulnérabilité exploitable, consultez notre [page Trust](https://trust.openclaw.ai) pour les instructions de divulgation responsable.

### Suggérer une atténuation

Vous avez une idée de comment traiter une menace existante ? Ouvrez une issue ou PR référençant la menace. Les atténuations utiles sont spécifiques et actionnables - par exemple, "limitation de débit par expéditeur de 10 messages/minute à la passerelle" est meilleur que "implémenter une limitation de débit".

### Proposer une chaîne d'attaque

Les chaînes d'attaque montrent comment plusieurs menaces se combinent en un scénario d'attaque réaliste. Si vous voyez une combinaison dangereuse, décrivez les étapes et comment un attaquant les enchaînerait. Un court récit de comment l'attaque se déroule en pratique est plus précieux qu'un template formel.

### Corriger ou améliorer le contenu existant

Fautes de frappe, clarifications, infos obsolètes, meilleurs exemples - PRs bienvenues, pas besoin d'issue.

## Ce que nous utilisons

### MITRE ATLAS

Ce modèle de menaces est construit sur [MITRE ATLAS](https://atlas.mitre.org/) (Adversarial Threat Landscape for AI Systems), un framework conçu spécifiquement pour les menaces AI/ML comme l'injection d'invite, l'abus d'outils, et l'exploitation d'agents. Vous n'avez pas besoin de connaître ATLAS pour contribuer - nous mappons les soumissions au framework pendant la revue.

### IDs de menace

Chaque menace obtient un ID comme `T-EXEC-003`. Les catégories sont :

| Code    | Catégorie                                      |
| ------- | ---------------------------------------------- |
| RECON   | Reconnaissance - collecte d'informations       |
| ACCESS  | Accès initial - obtenir l'entrée               |
| EXEC    | Exécution - exécuter des actions malveillantes |
| PERSIST | Persistance - maintenir l'accès                |
| EVADE   | Évasion de défense - éviter la détection       |
| DISC    | Découverte - apprendre l'environnement         |
| EXFIL   | Exfiltration - voler des données               |
| IMPACT  | Impact - dommages ou perturbation              |

Les IDs sont attribués par les mainteneurs pendant la revue. Vous n'avez pas besoin d'en choisir un.

### Niveaux de risque

| Niveau       | Signification                                                              |
| ------------ | -------------------------------------------------------------------------- |
| **Critique** | Compromis système complet, ou probabilité élevée + impact critique         |
| **Élevé**    | Dommages significatifs probables, ou probabilité moyenne + impact critique |
| **Moyen**    | Risque modéré, ou faible probabilité + impact élevé                        |
| **Faible**   | Improbable et impact limité                                                |

Si vous n'êtes pas sûr du niveau de risque, décrivez simplement l'impact et nous l'évaluerons.

## Processus de revue

1. **Triage** - Nous révisons les nouvelles soumissions dans les 48 heures
2. **Évaluation** - Nous vérifions la faisabilité, attribuons le mappage ATLAS et l'ID de menace, validons le niveau de risque
3. **Documentation** - Nous assurons que tout est formaté et complet
4. **Fusion** - Ajouté au modèle de menaces et à la visualisation

## Ressources

- [Site web ATLAS](https://atlas.mitre.org/)
- [Techniques ATLAS](https://atlas.mitre.org/techniques/)
- [Études de cas ATLAS](https://atlas.mitre.org/studies/)
- [Modèle de menaces OpenClaw](./THREAT-MODEL-ATLAS.md)

## Contact

- **Vulnérabilités de sécurité :** Consultez notre [page Trust](https://trust.openclaw.ai) pour les instructions de signalement
- **Questions sur le modèle de menaces :** Ouvrez une issue sur [openclaw/trust](https://github.com/openclaw/trust/issues)
- **Discussion générale :** Canal Discord #security

## Reconnaissance

Les contributeurs au modèle de menaces sont reconnus dans les remerciements du modèle de menaces, les notes de version, et le hall of fame de sécurité OpenClaw pour les contributions significatives.
