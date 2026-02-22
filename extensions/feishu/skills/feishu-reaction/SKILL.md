---
name: feishu-reaction
description: |
  Feishu reaction auto-reply. Automatically replies with emoji when user adds reaction.
  Activate when user mentions "reaction" or "emoji" in Feishu context.
---

# Feishu Reaction Auto-Reply

Built-in feature of the Feishu plugin. Automatically replies with relevant emoji when user adds a reaction.

## Implementation

**File**: `extensions/feishu/src/monitor.ts`

**Events Handled**:
- `im.message.reaction.created_v1` - User adds reaction
- `im.message.reaction.deleted_v1` - User removes reaction (logged only)

## Smart Reply Mapping

| Received Emoji | Bot Replies |
|----------------|-------------|
| THUMBSUP | FINGERHEART, HEART, SMILE, CLAP |
| HEART | FINGERHEART, SMILE, THUMBSUP |
| FINGERHEART | HEART, SMILE, THUMBSUP |
| SMILE | HEART, FINGERHEART, THUMBSUP |
| CLAP | HEART, FIRE, THUMBSUP |
| FIRE | PARTY, CLAP, THUMBSUP |
| CRY | HEART, FINGERHEART |
| Others | HEART, FINGERHEART, SMILE |

## Setup Requirements

### 1. Feishu Open Platform Event Subscription

Subscribe and publish these events:
- `im.message.reaction.created` - Message reaction added
- `im.message.reaction.deleted` - Message reaction removed

**Important**: Events must be published (not just saved) to take effect.

### 2. Robot Capability

Enable robot ability in Feishu app settings.

## Maintenance

### After OpenClaw Update

If this feature stops working after OpenClaw update:

1. Check if `extensions/feishu/src/monitor.ts` still has the reaction handler
2. If missing, re-apply the changes from the git stash or backup

### Recovery Steps

```bash
cd ~/openclaw
# Check if reaction handler exists
grep -n "im.message.reaction.created_v1" extensions/feishu/src/monitor.ts

# If not found, restore from stash
git stash list
git stash pop stash@{0} -- extensions/feishu/src/monitor.ts
```

### Backup Command

```bash
cd ~/openclaw
cp extensions/feishu/src/monitor.ts ~/backups/feishu-reaction-monitor-$(date +%Y%m%d).ts
```

## Configuration

No additional configuration needed. The feature is built into the Feishu plugin.

## Troubleshooting

### Bot doesn't respond to reactions

1. **Check event subscription**: Verify `im.message.reaction.created` is published
2. **Check gateway logs**: `tail -f ~/.openclaw/logs/gateway.log | grep reaction`
3. **Restart gateway**: `openclaw gateway restart`

### Infinite reaction loop

The code filters `operator_type=app` to prevent self-reaction loops. If broken, check that this filter is present.

## Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| No reaction events received | Events not published | Publish in Feishu Open Platform |
| 401 API error | Bot token expired | Update app credentials |
| Gateway crash on restart | Dirty workspace | Stash changes before update |