---
summary: "Instructions par defaut de l’agent OpenClaw et repertoire des Skills pour la configuration d’assistant personnel"
read_when:
  - Demarrage d’une nouvelle session d’agent OpenClaw
  - Activation ou audit des Skills par defaut
---

# AGENTS.md — Assistant personnel OpenClaw (par defaut)

## Premiere execution (recommande)

OpenClaw utilise un repertoire de travail dedie pour l’agent. Par defaut : `~/.openclaw/workspace` (configurable via `agents.defaults.workspace`).

1. Creez le repertoire de travail (s’il n’existe pas deja) :

```bash
mkdir -p ~/.openclaw/workspace
```

2. Copiez les modeles de repertoire de travail par defaut dans le repertoire de travail :

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. Optionnel : si vous souhaitez le repertoire de Skills d’assistant personnel, remplacez AGENTS.md par ce fichier :

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. Optionnel : choisissez un autre repertoire de travail en definissant `agents.defaults.workspace` (prend en charge `~`) :

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## Sécurité par défaut

- Ne pas copier les répertoires ou les secrets dans le chat.
- N’executez pas de commandes destructrices sauf demande explicite.
- N’envoyez pas de reponses partielles/en streaming vers des surfaces de messagerie externes (uniquement des reponses finales).

## Debut de session (obligatoire)

- Lisez `SOUL.md`, `USER.md`, `memory.md`, ainsi qu’aujourd’hui+hier dans `memory/`.
- Faites-le avant de repondre.

## Âme (obligatoire)

- `SOUL.md` definit l’identite, le ton et les limites. Maintenez-le a jour.
- Si vous modifiez `SOUL.md`, informez l’utilisateur.
- Vous etes une instance neuve a chaque session ; la continuite reside dans ces fichiers.

## Espaces partages (recommande)

- Vous n’etes pas la voix de l’utilisateur ; soyez prudent dans les discussions de groupe ou les canaux publics.
- Ne partagez pas de donnees privees, d’informations de contact ni de notes internes.

## Systeme de memoire (recommande)

- Journal quotidien : `memory/YYYY-MM-DD.md` (creez `memory/` si necessaire).
- Memoire long terme : `memory.md` pour les faits durables, preferences et decisions.
- Au demarrage de la session, lisez aujourd’hui + hier + `memory.md` si present.
- Capturez : decisions, preferences, contraintes, boucles ouvertes.
- Evitez les secrets sauf demande explicite.

## Outils & Skills

- Les outils vivent dans les Skills ; suivez le `SKILL.md` de chaque skill lorsque vous en avez besoin.
- Conservez les notes specifiques a l’environnement dans `TOOLS.md` (Notes pour les Skills).

## Astuce de sauvegarde (recommande)

Si vous considerez ce repertoire de travail comme la « memoire » de Clawd, faites-en un depot git (idealement prive) afin que `AGENTS.md` et vos fichiers de memoire soient sauvegardes.

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Optional: add a private remote + push
```

## Ce que fait OpenClaw

- Execute une Gateway (passerelle) WhatsApp + un agent de codage Pi afin que l’assistant puisse lire/ecrire des chats, recuperer du contexte et executer des Skills via le Mac hote.
- L’application macOS gere les autorisations (enregistrement d’ecran, notifications, microphone) et expose la CLI `openclaw` via son binaire integre.
- Les discussions directes se regroupent par defaut dans la session `main` de l’agent ; les groupes restent isoles comme `agent:<agentId>:<channel>:group:<id>` (salles/canaux : `agent:<agentId>:<channel>:channel:<id>`) ; des heartbeats maintiennent les taches en arriere-plan actives.

## Skills principaux (a activer dans Reglages → Skills)

- **mcporter** — Runtime/CLI de serveur d’outils pour gerer des backends de Skills externes.
- **Peekaboo** — Captures d’ecran macOS rapides avec analyse de vision IA optionnelle.
- **camsnap** — Capture d’images, de clips ou d’alertes de mouvement depuis des cameras de securite RTSP/ONVIF.
- **oracle** — CLI d’agent compatible OpenAI avec relecture de session et controle du navigateur.
- **eightctl** — Controlez votre sommeil depuis le terminal.
- **imsg** — Envoyer, lire et streamer iMessage et SMS.
- **wacli** — CLI WhatsApp : synchroniser, rechercher, envoyer.
- **discord** — Actions Discord : reactions, autocollants, sondages. Utilisez les cibles `user:<id>` ou `channel:<id>` (les identifiants numeriques nus sont ambigus).
- **gog** — CLI Google Suite : Gmail, Calendar, Drive, Contacts.
- **spotify-player** — Client Spotify en terminal pour rechercher/mettre en file/contrôler la lecture.
- **sag** — Voix ElevenLabs avec UX « say » a la mac ; diffuse vers les haut-parleurs par defaut.
- **Sonos CLI** — Controle des enceintes Sonos (decouverte/statut/lecture/volume/groupement) depuis des scripts.
- **blucli** — Lecture, groupement et automatisation des lecteurs BluOS depuis des scripts.
- **OpenHue CLI** — Controle de l’eclairage Philips Hue pour scenes et automatisations.
- **OpenAI Whisper** — Reconnaissance vocale locale pour la dictee rapide et les transcriptions de messagerie vocale.
- **Gemini CLI** — Modeles Google Gemini depuis le terminal pour des questions-reponses rapides.
- **agent-tools** — Boite a outils utilitaire pour les automatisations et scripts d’assistance.

## Notes d’utilisation

- Preferez la CLI `openclaw` pour le scripting ; l’application mac gere les autorisations.
- Lancez les installations depuis l’onglet Skills ; il masque le bouton si un binaire est deja present.
- Laissez les heartbeats actives afin que l’assistant puisse planifier des rappels, surveiller les boites de reception et declencher des captures de camera.
- L’interface Canvas s’execute en plein ecran avec des superpositions natives. Evitez de placer des controles critiques dans les bords haut-gauche/haut-droit/bas ; ajoutez des marges explicites dans la mise en page et ne vous fiez pas aux insets de zone sure.
- Pour la verification pilotee par le navigateur, utilisez `openclaw browser` (onglets/statut/capture d’ecran) avec le profil Chrome gere par OpenClaw.
- Pour l’inspection du DOM, utilisez `openclaw browser eval|query|dom|snapshot` (et `--json`/`--out` lorsque vous avez besoin d’une sortie machine).
- Pour les interactions, utilisez `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run` (cliquer/taper necessitent des references de snapshot ; utilisez `evaluate` pour les selecteurs CSS).
