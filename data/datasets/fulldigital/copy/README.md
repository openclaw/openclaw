# Full Digital — Copy Dataset

## Format
All copy files use JSONL format (one JSON object per line).

## Structure
- ads/ — Ad copy (hooks.jsonl, body.jsonl, ctas.jsonl)
- landing/ — Landing page copy (hero.jsonl, bullets.jsonl, faqs.jsonl)
- ui_microcopy/ — UI text (buttons.jsonl, empty_states.jsonl, tooltips.jsonl)
- annotations/outcomes.jsonl — Performance labels (approved/rejected/metrics)

## JSONL Entry Schema
{"id": "fd_hook_001", "text": "YOUR BRAND DESERVES BETTER", "type": "hook", "platform": "igfeed", "approved": true, "tags": ["confident", "minimal"]}
