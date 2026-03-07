# CUTMV — Copy Dataset

## Format
All copy files use JSONL format (one JSON object per line).

## Structure
- ads/ — Ad copy (hooks.jsonl, body.jsonl, ctas.jsonl)
- landing/ — Landing page copy (hero.jsonl, bullets.jsonl, faqs.jsonl)
- ui_microcopy/ — UI text (buttons.jsonl, empty_states.jsonl, tooltips.jsonl)
- annotations/outcomes.jsonl — Performance labels (approved/rejected/metrics)

## JSONL Entry Schema
{"id": "cutmv_hook_001", "text": "TURN MUSIC VIDEOS INTO VIRAL CLIPS", "type": "hook", "platform": "igfeed", "approved": true, "tags": ["direct", "creator-focused"]}
