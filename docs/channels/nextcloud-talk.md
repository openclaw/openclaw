# Nextcloud Talk Channel

## Registration Requirements

When installing your bot on Nextcloud via `occ`, you **must** include the `--feature response` flag. Without this, the bot will receive messages but will be unable to reply (Nextcloud will return 401 Unauthorized).

### Recommended Install Command:
```bash
sudo php occ talk:bot:install \
  --feature webhook --feature response --feature reaction \
  "BotName" "<secret>" "<webhook-url>"
```

## Common Issues
- **IP Address Required**: Use an IP address for the webhook URL if running in Docker, as Nextcloud containers often cannot resolve `.local` hostnames.
- **Webhook Port**: Ensure the webhook server port (default 8788) is open and accessible from your Nextcloud instance.
