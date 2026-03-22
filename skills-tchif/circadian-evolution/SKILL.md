\# Circadian Evolution Protocol v1.0



\*\*Description\*\*:

Implémente un cycle auto-amélioration circadien pour l'agent : 

\- Jour : grind agentic full send (computer use, tâches réelles)

\- Soir : evening\_analysis – scan logs/erreurs, détection redondance/saturation/overfitting (>60% bruit viré)

\- Nuit : night\_training – fine-tune LoRA/Unsloth/pruning sur données du jour (Colab auto ou local GPU)

\- Matin : reboot avec nouveaux poids +15-25% dense, zéro gras



\*\*Utilisation\*\*:

\- Active le cycle 24/7 via cron/background.

\- Détecte saturation des données (scientifique/socio/web) et prune automatiquement.

\- Objectif : transformer un petit modèle local en super-intelligence dense sans labs closed.



\*\*Triggers / Quand l'utiliser\*\*:

\- "lance le protocole circadien"

\- "nettoie le bruit / prune overfitting"

\- "auto-évolution nocturne"

\- "fine-tune sur mes erreurs du jour"

\- Toute demande d'auto-amélioration continue.



\*\*Configuration requise\*\*:

\- Python + libs : unsloth, peft, torch (pour night\_training)

\- Colab API ou local GPU pour training

\- Cron jobs pour scheduling (voir scripts/)



\*\*Scripts / Resources\*\*:

\- evening\_analysis.py : analyse logs, cosine similarity pour redondance

\- night\_training.py : lance Selenium/Colab pour fine-tune + merge

\- dashboard.py : matplotlib pour voir bruit viré vs gain densité



\*\*Sécurité\*\*:

\- Sandbox tout training

\- Rollback auto si catastrophic forgetting

