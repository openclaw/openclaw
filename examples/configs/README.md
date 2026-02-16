# Configuration Templates

These templates are designed to help you get started quickly with OpenClaw. Choose the one that best fits your needs.

## 1. Available Templates

| Template | Description | Use Case |
| :--- | :--- | :--- |
| **[basic-whatsapp.json](basic-whatsapp.json)** | Minimal WhatsApp setup. | **Beginners.** Best for first-time setup and testing. |
| **[multi-channel-advanced.json](multi-channel-advanced.json)** | Advanced multi-channel setup with security best practices. | **Power Users.** If you want to use multiple channels safely. |
| **[budget-friendly.json](budget-friendly.json)** | Cost-optimized setup using cheaper models. | **Budget Conscious.** If you want to keep API costs low. |

## 2. Setup Instructions

1.  **Stop openclaw** if it is running.
2.  **Copy** the desired template to your configuration directory:
    - **Linux/macOS**: `~/.openclaw/openclaw.json`
    - **Windows**: `C:\Users\YOUR_USER\.openclaw\openclaw.json`

    ```bash
    # Example (Linux/macOS)
    cp examples/configs/basic-whatsapp.json ~/.openclaw/openclaw.json
    ```

3.  **Edit** the file to replace placeholders (like `YOUR_PHONE_NUMBER`).
4.  **Start** openclaw:
    ```bash
    openclaw gateway
    ```

## 3. Security Checklist

> [!WARNING]
> Before deploying, verify these settings:

- [ ] **Change Passwords**: Replace `change-me-please` with a strong password.
- [ ] **Update allowFrom**: Replace wildcards `*` or example numbers with **your actual phone number/ID**.
- [ ] **Use Environment Variables**: For sensitive tokens, use `${VAR_NAME}` in config and set the variable in your shell or `.env` file.
- [ ] **Keep Gateway on Loopback**: Ensure `gateway.bind` is `127.0.0.1` unless you specifically need it exposed.

## 4. Configuration Comparison

| Feature | Basic | Advanced | Budget |
| :--- | :--- | :--- | :--- |
| **Primary Channel** | WhatsApp | WhatsApp, Telegram, Discord | WhatsApp |
| **Model** | Sonnet 3.5 | Opus 3 | Haiku 3 |
| **Security** | Password Auth | Env Vars, Strict allowFrom | Basic |
| **Browser Tool** | Disabled | Enabled | Disabled |
| **Est. Cost** | Medium | High | Low |

## 5. Troubleshooting

- **Config won't load**: Run `openclaw config validate` or check for JSON syntax errors (missing commas are common).
- **Channel not starting**: Check logs `openclaw gateway --verbose`.
- **Env vars not working**: Ensure variables are exported in your shell *before* starting openclaw.

## 6. Customization Tips

- **Mixing Templates**: You can copy sections (like the `channels` block) from one template to another.
- **Per-Channel Models**: You can override the main agent model for specific channels if supported by the channel adapter.

## 7. More Resources

- [Full Configuration Reference](https://docs.openclaw.ai/gateway/configuration)
- [Channel Guides](https://docs.openclaw.ai/channels)
- [Security Documentation](https://docs.openclaw.ai/gateway/security)
- [Model Comparison](https://docs.openclaw.ai/concepts/models)

## 8. Pro Tips

> [!TIP]
> - **Start Simple**: Begin with the `basic` template to ensure your system works.
> - **Test Locally**: Run `openclaw` locally before deploying to a server.
> - **Use `check-config`**: Run our config checker to catch common mistakes.
> - **Backups**: Keep a backup of your working `openclaw.json`.
> - **Monitor Costs**: Use `/usage tokens` to track your spend.
