---
summary: "Exécutions CLI `openclaw agent` directes (avec livraison optionnelle)"
read_when:
  - Ajout ou modification du point d'entrée CLI agent
title: "Envoi d'Agent"
---

# `openclaw agent` (exécutions d'agent directes)

`openclaw agent` exécute un seul tour d'agent sans avoir besoin d'un message de discussion entrant.
Par défaut, il passe **via la Passerelle** ; ajoutez `--local` pour forcer le runtime intégré sur la machine actuelle.

## Comportement

- Requis : `--message <text>`
- Sélection de session :
  - `--to <dest>` dérive la clé de session (les cibles groupe/canal préservent l'isolation ; les discussions directes se replient sur `main`), **ou**
  - `--session-id <id>` réutilise une session existante par id, **ou**
  - `--agent <id>` cible un agent configuré directement (utilise la clé de session `main` de cet agent)
- Exécute le même runtime d'agent intégré que les réponses entrantes normales.
- Les flags thinking/verbose persistent dans le magasin de session.
- Sortie :
  - par défaut : affiche le texte de réponse (plus les lignes `MEDIA:<url>`)
  - `--json` : affiche la charge utile structurée + métadonnées
- Livraison optionnelle vers un canal avec `--deliver` + `--channel` (les formats de cible correspondent à `openclaw message --target`).
- Utilisez `--reply-channel`/`--reply-to`/`--reply-account` pour remplacer la livraison sans changer la session.

Si la Passerelle est inaccessible, la CLI **se replie** sur l'exécution locale intégrée.

## Exemples

```bash
openclaw agent --to +15555550123 --message "mise à jour de statut"
openclaw agent --agent ops --message "Résumer les logs"
openclaw agent --session-id 1234 --message "Résumer la boîte de réception" --thinking medium
openclaw agent --to +15555550123 --message "Tracer les logs" --verbose on --json
openclaw agent --to +15555550123 --message "Invoquer réponse" --deliver
openclaw agent --agent ops --message "Générer rapport" --deliver --reply-channel slack --reply-to "#rapports"
```

## Flags

- `--local` : exécuter localement (nécessite des clés API de fournisseur de modèle dans votre shell)
- `--deliver` : envoyer la réponse au canal choisi
- `--channel` : canal de livraison (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, par défaut : `whatsapp`)
- `--reply-to` : remplacement de cible de livraison
- `--reply-channel` : remplacement de canal de livraison
- `--reply-account` : remplacement d'id de compte de livraison
- `--thinking <off|minimal|low|medium|high|xhigh>` : persister niveau de thinking (modèles GPT-5.2 + Codex uniquement)
- `--verbose <on|full|off>` : persister niveau verbose
- `--timeout <seconds>` : remplacer timeout d'agent
- `--json` : sortie JSON structurée
