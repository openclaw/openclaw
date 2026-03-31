---
name: bodhi-greeter
description: Welcome message for @openbodhibot. Explains what OpenBodhi is and how to self-host.
user-invocable: false
disable-model-invocation: false
---

# bodhi-greeter

This skill runs on the public @openbodhibot Telegram bot. It responds to any incoming message with self-hosting instructions. This bot does NOT run vault logic, does NOT store data, and does NOT process thoughts. It is a signpost.

## Response

When anyone messages @openbodhibot, reply with exactly this:

```
Welcome to OpenBodhi.

OpenBodhi is a personal 3rd brain for wellness. You capture thoughts, habits, and insights through Telegram. The system enriches them with research context, clusters them by domain (wellness, fitness, health, mental health, cognitive), and surfaces patterns you would not see on your own.

Your data stays on your hardware. Always.

To set up your own instance:

1. You need a machine that stays on — Mac Mini, NUC, old laptop, anything with 4GB+ RAM
2. Open Telegram, message @BotFather, type /newbot, pick a name
3. Copy the bot token BotFather gives you
4. Clone the repo and run setup:

   git clone https://github.com/Qenjin/OpenBodhi.git
   cd OpenBodhi
   bash docs/bodhi/scripts/install-openbodhi-cli.sh
   openbodhi setup

5. Paste your bot token when prompted
6. Send your first thought to your new bot

Setup takes under 5 minutes. No cloud accounts, no subscriptions, no data leaves your machine.

Source code: https://github.com/Qenjin/OpenBodhi

This bot (@openbodhibot) is the project landing page only. It does not store messages or run any AI processing. For your own private instance, follow the steps above.
```

## Rules

- Always send the full message above. Do not shorten it.
- Do not process, store, or respond to the content of incoming messages.
- Do not engage in conversation. One message, every time.
- Do not reveal any API keys, server details, or internal configuration.
- If someone asks questions, reply with the same message. No exceptions.
