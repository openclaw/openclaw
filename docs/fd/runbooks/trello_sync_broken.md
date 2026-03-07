# Runbook: Trello Sync Broken

## Detection
- GHL stages not updating when Trello cards move
- Sentry errors in trello webhook handler
- Missing `trello.card.moved` events in PostHog

## Diagnosis Steps
1. Check webhook registration: verify Trello webhook is active
2. Check gateway logs for Trello route errors
3. Verify Trello API key and token are valid
4. Test webhook manually: move a card and check logs

## Common Issues

### Webhook expired/deleted
```bash
# Re-register webhook via Trello API
# Use TrelloClient.register_webhook()
```

### Authentication failure
- Regenerate Trello token
- Update `.env` with new credentials
- Restart gateway

### Board ID mismatch
- Verify the board_id in webhook matches the expected board
- Update webhook model ID if board was recreated

## Recovery
1. Fix the root cause (credentials, webhook registration, etc.)
2. Check for missed card movements in Trello
3. Manually update any GHL stages that were missed
4. Verify sync is working by moving a test card
