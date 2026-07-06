# WhatsApp extension

This extension exposes a registerWhatsAppRuntime(hostRuntime) helper that registers a webhook handler at /webhook/whatsapp and exposes a whatsappService on the host runtime for outbound sends.

Environment variables required:

- WHATSAPP_ACCESS_TOKEN
- WHATSAPP_PHONE_NUMBER_ID
- WHATSAPP_WEBHOOK_VERIFY_TOKEN
- WHATSAPP_BUSINESS_ACCOUNT_ID (optional)
