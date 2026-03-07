# Aspect Ratio Labeling

## Purpose

Automatically detect aspect ratios from card title/description and apply standardized Trello labels.

Clients frequently include:

- "4:5"
- "9:16"
- "1:1"
- "16x9"
- "vertical"
- "horizontal"

System normalizes to internal label schema.

## Canonical Labels

| Label | Meaning |
|-------|---------|
| `AR: 1:1` | Square |
| `AR: 4:5` | Instagram portrait |
| `AR: 9:16` | Vertical / Stories / Reels |
| `AR: 16:9` | Horizontal / YouTube |

## Detection Patterns

| Pattern | Label |
|---------|-------|
| `1:1` or `1x1` | `AR: 1:1` |
| `4:5` or `4x5` | `AR: 4:5` |
| `9:16` or `9x16` or `vertical` | `AR: 9:16` |
| `16:9` or `16x9` or `horizontal` | `AR: 16:9` |

All matching is case-insensitive with word boundaries.

## Behavior

On request intake (card created or moved into request list):

1. Scan `card_name` + `card_description`
2. Detect all matching aspect ratios
3. Ensure each label exists on the board (create if missing, color: `sky`)
4. Apply labels to the card

## Idempotency

- If label already applied to card, skip
- If label missing from board, create first
- Do not duplicate labels

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `TRELLO_AUTO_AR_LABELS` | `true` | Toggle aspect ratio auto-labeling |

## Safety Mode

If `DRY_RUN=true`:

- Log detected labels via audit
- Do not modify Trello

## Related Files

| What | Where |
|------|-------|
| Detection + apply logic | `packages/domain/trello_aspect_ratio_labels.py` |
| Trello webhook handler | `services/webhook_gateway/routes/trello.py` |
| Label API | `packages/integrations/trello/client.py` (`create_label`, `add_label_to_card`) |
