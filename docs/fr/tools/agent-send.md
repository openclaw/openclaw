---
summary: "Executions directes du CLI `openclaw agent` (avec livraison optionnelle)"
read_when:
  - Ajout ou modification du point d’entree du CLI de l’agent
title: "Envoi d’agent"
---

# `openclaw agent` (executions directes de l’agent)

`openclaw agent` execute un seul tour d’agent sans necessiter de message de chat entrant.
Par defaut, il passe **par la Gateway (passerelle)** ; ajoutez `--local` pour forcer le
runtime integre sur la machine courante.

## Comportement

- Requis : `--message <text>`
- Selection de session :
  - `--to <dest>` derive la cle de session (les cibles groupe/canal preservent l’isolation ; les discussions directes se regroupent en `main`), **ou**
  - `--session-id <id>` reutilise une session existante par identifiant, **ou**
  - `--agent <id>` cible directement un agent configure (utilise la cle de session `main` de cet agent)
- Execute le meme runtime d’agent integre que les reponses entrantes normales.
- Les indicateurs de raisonnement/verbeux persistent dans le stockage de session.
- Sortie :
  - par defaut : affiche le texte de reponse (ainsi que les lignes `MEDIA:<url>`)
  - `--json` : affiche la charge utile structuree + les metadonnees
- Livraison optionnelle vers un canal avec `--deliver` + `--channel` (les formats de cible correspondent a `openclaw message --target`).
- Utilisez `--reply-channel`/`--reply-to`/`--reply-account` pour remplacer la livraison sans modifier la session.

Si la Gateway (passerelle) est inaccessible, le CLI **bascule** vers l’execution locale integree.

## Exemples

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## Drapeaux

- `--local` : execution locale (necessite les cles API du fournisseur de modele dans votre shell)
- `--deliver` : envoyer la reponse vers le canal choisi
- `--channel` : canal de livraison (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, par defaut : `whatsapp`)
- `--reply-to` : remplacement de la cible de livraison
- `--reply-channel` : remplacement du canal de livraison
- `--reply-account` : remplacement de l’identifiant de compte de livraison
- `--thinking <off|minimal|low|medium|high|xhigh>` : persister le niveau de raisonnement (modeles GPT-5.2 + Codex uniquement)
- `--verbose <on|full|off>` : persister le niveau verbeux
- `--timeout <seconds>` : remplacer le delai d’expiration de l’agent
- `--json` : sortie JSON structuree
