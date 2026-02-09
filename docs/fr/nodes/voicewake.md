---
summary: "Mots de reveil vocaux globaux (appartenant a la Gateway) et leur synchronisation entre les nœuds"
read_when:
  - Modification du comportement ou des valeurs par defaut des mots de reveil vocaux
  - Ajout de nouvelles plateformes de nœuds necessitant la synchronisation des mots de reveil
title: "Reveil vocal"
---

# Reveil vocal (mots de reveil globaux)

OpenClaw traite les **mots de reveil comme une liste globale unique** detenue par la **Gateway (passerelle)**.

- Il n'y a \*\*pas de mots de réveil personnalisés par node \*\*.
- **Toute interface de nœud/application peut modifier** la liste ; les changements sont persistés par la Gateway et diffuses a tous.
- Chaque appareil conserve toutefois son propre interrupteur **Reveil vocal active/desactive** (UX locale + permissions differentes).

## Stockage (hote de la Gateway)

Les mots de reveil sont stockes sur la machine de la Gateway a l’emplacement suivant :

- `~/.openclaw/settings/voicewake.json`

Forme :

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## Protocole

### Methodes

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set` avec les parametres `{ triggers: string[] }` → `{ triggers: string[] }`

Notes :

- Les declencheurs sont normalises (espaces supprimes, vides elimines). Les listes vides reviennent aux valeurs par defaut.
- Des limites sont appliquees pour la securite (plafonds de nombre et de longueur).

### Evenements

- `voicewake.changed` charge utile `{ triggers: string[] }`

Qui le recoit :

- Tous les clients WebSocket (application macOS, WebChat, etc.).
- Tous les nœuds connectes (iOS/Android), ainsi qu’a la connexion d’un nœud comme envoi initial de l’« etat courant ».

## Comportement du client

### Application macOS

- Utilise la liste globale pour filtrer les declencheurs `VoiceWakeRuntime`.
- La modification des « mots declencheurs » dans les parametres de Reveil vocal appelle `voicewake.set`, puis s’appuie sur la diffusion pour maintenir les autres clients synchronises.

### Nœud iOS

- Utilise la liste globale pour la detection des declencheurs `VoiceWakeManager`.
- La modification des mots de reveil dans les Parametres appelle `voicewake.set` (via le WS de la Gateway) et maintient egalement une detection locale des mots de reveil reactive.

### Nœud Android

- Expose un éditeur Wake Words dans les paramètres.
- Appelle `voicewake.set` via le WS de la Gateway afin que les modifications se synchronisent partout.
