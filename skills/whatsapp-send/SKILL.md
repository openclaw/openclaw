---
name: whatsapp-send
description: Send WhatsApp messages to a specific phone number via the macOS desktop app or WhatsApp URL scheme. Automatically opens WhatsApp, types the message, and sends it. Requires \"Accessibility\" permissions for the OpenClaw execution environment (e.g., Terminal.app).
homepage: https://www.whatsapp.com/
metadata: {\"clawdbot\":{\"emoji\":\"💬\"}}
---

# WhatsApp Message Sender (`whatsapp-send`)

This skill allows OpenClaw to send WhatsApp messages to a specified phone number directly through the macOS WhatsApp desktop application. It leverages the `whatsapp://send` URL scheme to open the app with a pre-filled message, and then uses AppleScript to simulate the Enter key press for sending.

## Setup & Permissions

**CRITICAL: macOS Accessibility Permissions are required!**

For this skill to function correctly, the application running OpenClaw (e.g., Terminal.app, iTerm2, or the OpenClaw daemon process itself) **must have "Accessibility" permissions** in your macOS System Settings. If these permissions are not granted, the script will fail with an error like "osascript에서 키스트로크를 보내도록 허용되지 않습니다. (1002)".

**Steps to grant permission:**

1.  Open **"System Settings"** (or "System Preferences" on older macOS).
2.  Go to **"Privacy & Security"** (or "Security & Privacy").
3.  Scroll down and click **"Accessibility"**.
4.  Find and **check the box** next to the application running OpenClaw (e.g., "Terminal.app"). If it's not listed, click the "+" button, navigate to your `/Applications/Utilities/` folder (or where your terminal app is located), select it, and then check the box.

## Usage

Use the `scripts/send_whatsapp_message.py` script included in this skill. It takes the recipient's phone number and the message text as arguments.

```bash
.venv/bin/python ~/.openclaw/workspace/skills/whatsapp-send/scripts/send_whatsapp_message.py <phone_number_with_country_code> <message_text>
```

**Arguments:**

- `<phone_number_with_country_code>`: The full phone number of the recipient, including the country code (e.g., `+821012345678`).
- `<message_text>`: The message you want to send.

**Example (sending "Hello from OpenClaw!" to +821098923866):**

```bash
exec command=".venv/bin/python ~/.openclaw/workspace/skills/whatsapp-send/scripts/send_whatsapp_message.py +821098923866 'Hello from OpenClaw!'"
```

### How it Works Internally

The script performs the following actions:

1.  Constructs a `whatsapp://send` URL with the provided phone number and URL-encoded message.
2.  Executes `open "whatsapp://send?phone=...&text=..."` to launch WhatsApp and pre-fill the message.
3.  Waits for 3 seconds (`sleep 3`) to allow WhatsApp to open and load the chat.
4.  Uses `osascript` (AppleScript) to simulate `Command + A` (select all) and `Delete` keys to clear any existing text in the input field.
5.  Uses `osascript` to simulate typing the new message.
6.  Uses `osascript` to simulate the `Enter` key press to send the message.

## Limitations

- **macOS Only:** This skill is specifically designed for macOS due to its reliance on AppleScript and `open` command behavior.
- **Desktop App Dependency:** Requires the WhatsApp desktop application to be installed and configured on the macOS system.
- **UI Stability:** Relies on the WhatsApp app's UI elements and their responsiveness. App updates may break the AppleScript automation.
- **Accessibility Permissions:** Failure to grant the necessary "Accessibility" permissions will prevent the script from sending messages.
- **No Delivery Confirmation:** The script can only confirm the message was "sent" from the local app, not that it was delivered or read by the recipient.
