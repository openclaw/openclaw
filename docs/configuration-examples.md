---
summary: "Complete configuration examples with explanations for new users"
read_when:
  - Learning how to configure clawdbot
  - Looking for configuration examples
  - Setting up clawdbot for the first time
---
# Configuration Examples

This guide shows complete configuration examples built directly from the actual configuration schema. Perfect for getting started or understanding the full range of options available.

## Quick Start: What You Actually Need

**The truth**: You probably don't need most of these options! Here's what matters for most users:

### Absolute Minimum (5 lines)
```json5
{
  agent: { workspace: "~/clawd" },
  whatsapp: { allowFrom: ["+1234567890"] }  // Replace with your real number
}
```

Save this to `~/.clawdbot/clawdbot.json` and you're ready to go.

### Recommended Starting Config (10 lines)
```json5
{
  identity: {
    name: "Clawd",
    theme: "helpful assistant"
  },
  agent: {
    workspace: "~/clawd",
    model: { primary: "anthropic/claude-sonnet-4-5" }
  },
  whatsapp: {
    allowFrom: ["+1234567890"],  // Your phone number
    groups: { "*": { requireMention: true } }
  }
}
```

This gives you:
- A named identity for your bot
- A dedicated workspace folder
- WhatsApp access restricted to your number
- Group chat protection (requires @mention to respond)

---

## Complete Example: All Options (Schema-Validated)

Below is a **comprehensive** configuration showing every major option that actually exists in the codebase. This example is built directly from the Zod schema to ensure accuracy.

> **Note**: This uses JSON5 format, which allows comments (`//`) and trailing commas. Regular JSON works too.

```json5
{
  // ========================================
  // ENVIRONMENT & SHELL
  // ========================================
  // Load environment variables from your shell profile
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000
    }
  },

  // ========================================
  // AUTHENTICATION PROFILES
  // ========================================
  // IMPORTANT: Auth method (OAuth vs API key) is separate from model names!
  // - Model names are ALWAYS the same: "anthropic/claude-sonnet-4-5"
  // - Auth method is configured here in profiles
  //
  // OAuth vs API Key:
  // - OAuth: Claude Pro/Max subscription, ChatGPT Plus/Team subscription
  // - API Key: Pay-per-use API access
  //
  // The system automatically uses the right auth based on which profile is active
  auth: {
    profiles: {
      // Anthropic Claude - OAuth mode (requires Claude Pro/Max subscription)
      "anthropic:default": {
        provider: "anthropic",
        mode: "oauth",
        email: "me@example.com"
      },

      // Anthropic Claude - API Key mode (pay-per-use)
      "anthropic:work": {
        provider: "anthropic",
        mode: "api_key"
      },

      // OpenAI - API Key mode
      "openai:default": {
        provider: "openai",
        mode: "api_key"
      },

      // OpenAI - OAuth mode (requires ChatGPT Plus/Team)
      // Note: Use "openai-codex" provider for OAuth
      "openai-codex:default": {
        provider: "openai-codex",
        mode: "oauth"
      }
    },

    // Failover order - tries profiles in this order when one fails
    order: {
      anthropic: ["anthropic:default", "anthropic:work"],
      openai: ["openai:default"],
      "openai-codex": ["openai-codex:default"]
    }
  },

  // ========================================
  // BOT IDENTITY
  // ========================================
  // Give your bot a personality
  // These values affect default behaviors (ackReaction, mentionPatterns)
  identity: {
    name: "Samantha",
    theme: "helpful sloth",
    emoji: "🦥"
  },

  // ========================================
  // WIZARD STATE (Auto-generated)
  // ========================================
  // Tracks onboarding completion - you usually don't edit this manually
  wizard: {
    lastRunAt: "2026-01-01T00:00:00.000Z",
    lastRunVersion: "2026.1.4",
    lastRunCommit: "abc1234",
    lastRunCommand: "configure",
    lastRunMode: "local"  // local or remote
  },

  // ========================================
  // LOGGING
  // ========================================
  logging: {
    level: "info",                    // silent, fatal, error, warn, info, debug, trace
    file: "/tmp/clawdbot/clawdbot.log",
    consoleLevel: "info",
    consoleStyle: "pretty",           // pretty, compact, json
    redactSensitive: "tools",         // off, tools
    redactPatterns: [
      "\\bTOKEN\\b\\s*[=:]\\s*([\"']?)([^\\s\"']+)\\1",
      "/\\bsk-[A-Za-z0-9_-]{8,}\\b/gi"
    ]
  },

  // ========================================
  // MESSAGE FORMATTING
  // ========================================
  messages: {
    messagePrefix: "[clawdbot]",
    responsePrefix: "🦞",
    ackReaction: "👀",
    ackReactionScope: "group-mentions"  // group-mentions, group-all, direct, all
  },

  // ========================================
  // MESSAGE ROUTING & QUEUING
  // ========================================
  routing: {
    groupChat: {
      mentionPatterns: ["@clawd", "clawdbot", "clawd"],
      historyLimit: 50
    },
    queue: {
      mode: "collect",          // steer, followup, collect, steer-backlog, steer+backlog, queue, interrupt
      debounceMs: 1000,
      cap: 20,
      drop: "summarize",        // old, new, summarize
      bySurface: {
        whatsapp: "collect",
        telegram: "collect",
        discord: "collect",
        slack: "collect",
        signal: "collect",
        imessage: "collect",
        webchat: "collect"
      }
    },
    transcribeAudio: {
      command: ["whisper", "--model", "base"],
      timeoutSeconds: 120
    }
  },

  // ========================================
  // SESSION MANAGEMENT
  // ========================================
  session: {
    scope: "per-sender",          // per-sender or global
    idleMinutes: 60,
    heartbeatIdleMinutes: 120,
    resetTriggers: ["/new", "/reset"],
    store: "~/.clawdbot/sessions/sessions.json",
    typingIntervalSeconds: 5,
    mainKey: "main",
    agentToAgent: {
      maxPingPongTurns: 5
    },
    sendPolicy: {
      default: "allow",           // allow or deny
      rules: [
        {
          action: "deny",
          match: {
            surface: "discord",
            chatType: "group"     // direct, group, room
          }
        }
      ]
    }
  },

  // ========================================
  // WHATSAPP
  // ========================================
  whatsapp: {
    allowFrom: ["+15555550123"],
    groupPolicy: "open",          // open, disabled, allowlist
    textChunkLimit: 4000,
    groups: {
      "*": { requireMention: true }
    }
  },

  // ========================================
  // WEB INTERFACE
  // ========================================
  web: {
    enabled: true,
    heartbeatSeconds: 60,
    reconnect: {
      initialMs: 2000,
      maxMs: 120000,
      factor: 1.4,
      jitter: 0.2,
      maxAttempts: 0
    }
  },

  // ========================================
  // TELEGRAM
  // ========================================
  telegram: {
    enabled: true,
    botToken: "YOUR_TELEGRAM_BOT_TOKEN",
    replyToMode: "off",           // off, first, all
    groupPolicy: "open",
    allowFrom: ["123456789"],
    textChunkLimit: 4000,
    mediaMaxMb: 5,
    proxy: "socks5://localhost:9050",
    webhookUrl: "https://example.com/telegram-webhook",
    webhookSecret: "secret",
    webhookPath: "/telegram-webhook",
    groups: {
      "*": { requireMention: true }
    }
  },

  // ========================================
  // DISCORD
  // ========================================
  discord: {
    enabled: true,
    token: "YOUR_DISCORD_BOT_TOKEN",
    textChunkLimit: 4000,
    mediaMaxMb: 8,
    historyLimit: 20,
    replyToMode: "off",
    actions: {
      reactions: true,
      stickers: true,
      polls: true,
      permissions: true,
      messages: true,
      threads: true,
      pins: true,
      search: true,
      memberInfo: true,
      roleInfo: true,
      roles: false,
      channelInfo: true,
      voiceStatus: true,
      events: true,
      moderation: false
    },
    slashCommand: {
      enabled: true,
      name: "clawd",
      sessionPrefix: "discord:slash",
      ephemeral: true
    },
    dm: {
      enabled: true,
      allowFrom: ["1234567890", "steipete"],
      groupEnabled: false,
      groupChannels: ["clawd-dm"]
    },
    guilds: {
      "123456789012345678": {
        slug: "friends-of-clawd",
        requireMention: false,
        reactionNotifications: "own",  // off, own, all, allowlist
        users: ["987654321098765432"],
        channels: {
          general: { allow: true },
          help: { allow: true, requireMention: true }
        }
      }
    }
  },

  // ========================================
  // SLACK
  // ========================================
  slack: {
    enabled: true,
    botToken: "xoxb-REPLACE_ME",
    appToken: "xapp-REPLACE_ME",
    textChunkLimit: 4000,
    mediaMaxMb: 20,
    reactionNotifications: "own",  // off, own, all, allowlist
    reactionAllowlist: ["U123"],
    actions: {
      reactions: true,
      messages: true,
      pins: true,
      search: true,
      permissions: true,
      memberInfo: true,
      channelInfo: true,
      emojiList: true
    },
    slashCommand: {
      enabled: true,
      name: "clawd",
      sessionPrefix: "slack:slash",
      ephemeral: true
    },
    dm: {
      enabled: true,
      allowFrom: ["U123", "U456"],
      groupEnabled: false,
      groupChannels: ["G123"]
    },
    channels: {
      C123: { allow: true, requireMention: true },
      "#general": { allow: true, requireMention: false }
    }
  },

  // ========================================
  // SIGNAL
  // ========================================
  signal: {
    enabled: true,
    account: "+15555550123",
    httpUrl: "http://localhost:8080",
    httpHost: "localhost",
    httpPort: 8080,
    cliPath: "/usr/local/bin/signal-cli",
    autoStart: true,
    receiveMode: "on-start",      // on-start or manual
    ignoreAttachments: false,
    ignoreStories: true,
    sendReadReceipts: false,
    allowFrom: ["+15555550123"],
    textChunkLimit: 4000,
    mediaMaxMb: 5
  },

  // ========================================
  // IMESSAGE (macOS only)
  // ========================================
  imessage: {
    enabled: true,
    cliPath: "imsg",
    dbPath: "~/Library/Messages/chat.db",
    service: "auto",              // imessage, sms, auto
    allowFrom: ["+15555550123", "user@example.com"],
    includeAttachments: false,
    mediaMaxMb: 16,
    textChunkLimit: 4000,
    groups: {
      "*": { requireMention: true }
    }
  },

  // ========================================
  // TEXT-TO-SPEECH (ElevenLabs)
  // ========================================
  talk: {
    voiceId: "elevenlabs_voice_id",
    voiceAliases: {
      Clawd: "EXAVITQu4vr4xnSDxMaL",
      Roger: "CwhRBWXzGAHq8TQ4Fs17"
    },
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "ELEVENLABS_API_KEY",
    interruptOnSpeech: true
  },

  // ========================================
  // AGENT (The AI Brain)
  // ========================================
  agent: {
    workspace: "~/clawd",
    userTimezone: "America/Chicago",

    // Model configuration - which models to use
    model: {
      primary: "anthropic/claude-sonnet-4-5",
      fallbacks: [
        "anthropic/claude-opus-4-5",
        "openai/gpt-5.2"
      ]
    },

    // Image model configuration (for vision tasks)
    imageModel: {
      primary: "openrouter/qwen/qwen-2.5-vl-72b-instruct:free",
      fallbacks: ["openrouter/google/gemini-2.0-flash-vision:free"]
    },

    // Model registry - define aliases for models
    models: {
      "anthropic/claude-opus-4-5": { alias: "opus" },
      "anthropic/claude-sonnet-4-5": { alias: "sonnet" },
      "openai/gpt-5.2": { alias: "gpt" }
    },

    // Agent behavior settings
    contextTokens: 200000,
    thinkingDefault: "low",       // off, minimal, low, medium, high
    verboseDefault: "off",        // off, on
    elevatedDefault: "on",        // off, on
    blockStreamingDefault: "on",  // off, on
    blockStreamingBreak: "text_end",  // text_end, message_end
    blockStreamingChunk: {
      minChars: 800,
      maxChars: 1200,
      breakPreference: "paragraph"  // paragraph, newline, sentence
    },
    timeoutSeconds: 600,
    mediaMaxMb: 5,
    typingIntervalSeconds: 5,
    maxConcurrent: 3,

    // Tool permissions
    tools: {
      allow: ["bash", "process", "read", "write", "edit"],
      deny: ["browser", "canvas"]
    },

    // Bash tool configuration
    bash: {
      backgroundMs: 10000,
      timeoutSec: 1800,
      cleanupMs: 1800000
    },

    // Heartbeat configuration
    heartbeat: {
      every: "30m",
      model: "anthropic/claude-sonnet-4-5",
      target: "last",             // last, whatsapp, telegram, discord, slack, signal, imessage, none
      to: "+15555550123",
      prompt: "HEARTBEAT",
      ackMaxChars: 30
    },

    // Elevated mode - privileged operations
    elevated: {
      enabled: true,
      allowFrom: {
        whatsapp: ["+15555550123"],
        telegram: ["123456789"],
        discord: ["steipete"],
        slack: ["U123"],
        signal: ["+15555550123"],
        imessage: ["user@example.com"],
        webchat: ["session:demo"]
      }
    },

    // Sandbox configuration
    sandbox: {
      mode: "non-main",           // off, non-main, all
      perSession: true,
      workspaceRoot: "~/.clawdbot/sandboxes",
      docker: {
        image: "clawdbot-sandbox:bookworm-slim",
        containerPrefix: "clawdbot-sbx-",
        workdir: "/workspace",
        readOnlyRoot: true,
        tmpfs: ["/tmp", "/var/tmp", "/run"],
        network: "none",
        user: "1000:1000",
        capDrop: ["ALL"],
        env: { LANG: "C.UTF-8" },
        setupCommand: "apt-get update && apt-get install -y git curl jq",
        pidsLimit: 256,
        memory: "1g",
        memorySwap: "2g",
        cpus: 1,
        ulimits: {
          nofile: { soft: 1024, hard: 2048 },
          nproc: 256
        },
        seccompProfile: "/path/to/seccomp.json",
        apparmorProfile: "clawdbot-sandbox",
        dns: ["1.1.1.1", "8.8.8.8"],
        extraHosts: ["internal.service:10.0.0.5"]
      },
      browser: {
        enabled: false,
        image: "clawdbot-sandbox-browser:bookworm-slim",
        containerPrefix: "clawdbot-sbx-browser-",
        cdpPort: 9222,
        vncPort: 5900,
        noVncPort: 6080,
        headless: false,
        enableNoVnc: true
      },
      tools: {
        allow: ["bash", "process", "read", "write", "edit"],
        deny: ["browser", "canvas"]
      },
      prune: {
        idleHours: 24,
        maxAgeDays: 7
      }
    }
  },

  // ========================================
  // CUSTOM MODEL PROVIDERS
  // ========================================
  models: {
    mode: "merge",                // merge or replace
    providers: {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "LITELLM_KEY",
        api: "openai-completions",  // openai-completions, openai-responses, anthropic-messages, google-generative-ai
        authHeader: true,
        headers: { "X-Proxy-Region": "us-west" },
        models: [
          {
            id: "llama-3.1-8b",
            name: "Llama 3.1 8B",
            api: "openai-completions",
            reasoning: false,
            input: ["text"],
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0
            },
            contextWindow: 128000,
            maxTokens: 32000,
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
              maxTokensField: "max_tokens"
            }
          }
        ]
      }
    }
  },

  // ========================================
  // CRON (Scheduled Tasks)
  // ========================================
  cron: {
    enabled: true,
    store: "~/.clawdbot/cron/cron.json",
    maxConcurrentRuns: 2
  },

  // ========================================
  // WEBHOOKS (Inbound HTTP)
  // ========================================
  hooks: {
    enabled: true,
    path: "/hooks",
    token: "shared-secret",
    maxBodyBytes: 1048576,
    presets: ["gmail"],
    transformsDir: "~/.clawdbot/hooks",
    mappings: [
      {
        id: "gmail-hook",
        match: { path: "gmail" },
        action: "agent",          // wake or agent
        wakeMode: "now",          // now or next-heartbeat
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "From: {{messages[0].from}}\nSubject: {{messages[0].subject}}",
        textTemplate: "{{messages[0].snippet}}",
        deliver: true,
        channel: "last",          // last, whatsapp, telegram, discord, slack, signal, imessage
        to: "+15555550123",
        thinking: "low",
        timeoutSeconds: 300,
        transform: {
          module: "./transforms/gmail.js",
          export: "transformGmail"
        }
      }
    ],
    gmail: {
      account: "clawdbot@gmail.com",
      label: "INBOX",
      topic: "projects/<project-id>/topics/gog-gmail-watch",
      subscription: "gog-gmail-watch-push",
      pushToken: "shared-push-token",
      hookUrl: "http://127.0.0.1:18789/hooks/gmail",
      includeBody: true,
      maxBytes: 20000,
      renewEveryMinutes: 720,
      serve: {
        bind: "127.0.0.1",
        port: 8788,
        path: "/"
      },
      tailscale: {
        mode: "funnel",           // off, serve, funnel
        path: "/gmail-pubsub"
      }
    }
  },

  // ========================================
  // BROWSER AUTOMATION
  // ========================================
  browser: {
    enabled: true,
    controlUrl: "http://127.0.0.1:18791",
    cdpUrl: "http://127.0.0.1:9222",
    color: "#FF4500",
    executablePath: "/usr/bin/chromium",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    defaultProfile: "clawd",
    profiles: {
      clawd: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" }
    }
  },

  // ========================================
  // UI CUSTOMIZATION
  // ========================================
  ui: {
    seamColor: "#FF4500"
  },

  // ========================================
  // GATEWAY (Server/Networking)
  // ========================================
  gateway: {
    mode: "local",                // local or remote
    port: 18789,
    bind: "loopback",             // auto, lan, tailnet, loopback
    controlUi: {
      enabled: true,
      basePath: "/clawdbot"
    },
    auth: {
      mode: "token",              // token or password
      token: "gateway-token",
      password: "gateway-password",
      allowTailscale: true
    },
    tailscale: {
      mode: "serve",              // off, serve, funnel
      resetOnExit: false
    },
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "remote-token",
      password: "remote-password"
    },
    reload: {
      mode: "hybrid",             // off, restart, hot, hybrid
      debounceMs: 300
    }
  },

  // ========================================
  // BRIDGE (Agent-to-Agent Communication)
  // ========================================
  bridge: {
    enabled: true,
    port: 18790,
    bind: "tailnet"               // auto, lan, tailnet, loopback
  },

  // ========================================
  // DISCOVERY (Network Service Discovery)
  // ========================================
  discovery: {
    wideArea: {
      enabled: true
    }
  },

  // ========================================
  // CANVAS HOST (Live HTML/Web Apps)
  // ========================================
  canvasHost: {
    enabled: true,
    root: "~/clawd/canvas",
    port: 18793,
    liveReload: true
  },

  // ========================================
  // SKILLS (Custom Tools/Commands)
  // ========================================
  skills: {
    allowBundled: ["brave-search", "gemini"],
    load: {
      extraDirs: [
        "~/Projects/agent-scripts/skills",
        "~/Projects/oss/some-skill-pack/skills"
      ]
    },
    install: {
      preferBrew: true,
      nodeManager: "npm"          // npm, pnpm, yarn, bun
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE"
        }
      },
      peekaboo: { enabled: true },
      sag: { enabled: false }
    }
  }
}
```

---

## Understanding the Sections

### Core Essentials (Start Here)

These are the sections most users actually configure:

- **`identity`** - Give your bot a name and personality
- **`agent.workspace`** - Where the bot can read/write files (keep it sandboxed!)
- **`agent.model`** - Which AI model to use
- **Platform sections** (`whatsapp`, `telegram`, `discord`, etc.) - Connect your messaging platforms

### Authentication (OAuth vs API Key)

**Critical concept**: Model names **never change** based on how you authenticate!

- **Model names are always the same**: `anthropic/claude-sonnet-4-5`, `anthropic/claude-opus-4-5`, etc.
- **Auth method is configured separately** in `auth.profiles`

**Two ways to authenticate:**
- **OAuth** (subscription): Claude Pro/Max, ChatGPT Plus/Team
  - Pay a monthly subscription fee
  - Access to subscription-tier models
  - Configure with `mode: "oauth"`
- **API Key** (pay-per-use): Direct API access
  - Pay for what you use (per-token pricing)
  - Configure with `mode: "api_key"`

**Example using the SAME model with different auth:**
```json5
{
  auth: {
    profiles: {
      "anthropic:personal": { provider: "anthropic", mode: "oauth" },  // Subscription
      "anthropic:work": { provider: "anthropic", mode: "api_key" }     // Pay-per-use
    }
  },
  agent: {
    // Same model name works with BOTH auth methods above
    model: { primary: "anthropic/claude-sonnet-4-5" }
  }
}
```

### Security & Access Control

- **`allowFrom`** arrays - Whitelist who can use the bot (use real phone numbers/IDs!)
- **`elevated.allowFrom`** - Who gets privileged operations (be careful!)
- **`sandbox`** - Isolate the bot's operations (advanced users)

### Advanced Features (Optional)

- **`skills`** - Add custom tools and commands
- **`browser`** - Enable browser automation
- **`cron`** - Schedule recurring tasks
- **`hooks`** - Receive webhooks from external services
- **`models`** - Add custom/local AI models

---

## Common Patterns

### Multi-Platform Setup
```json5
{
  agent: { workspace: "~/clawd" },
  whatsapp: { allowFrom: ["+1234567890"] },
  telegram: {
    enabled: true,
    botToken: "YOUR_TOKEN",
    allowFrom: ["123456789"]
  },
  discord: {
    enabled: true,
    token: "YOUR_TOKEN",
    dm: { allowFrom: ["yourname"] }
  }
}
```

### OAuth with API Key Failover
Use your Claude Pro subscription, with automatic fallback to API key if needed:
```json5
{
  auth: {
    profiles: {
      // Primary: Use Claude Pro subscription
      "anthropic:subscription": {
        provider: "anthropic",
        mode: "oauth",
        email: "me@example.com"
      },
      // Fallback: Use pay-per-use API key if subscription fails
      "anthropic:api": {
        provider: "anthropic",
        mode: "api_key"
      }
    },
    order: {
      // Try subscription first, fall back to API key
      anthropic: ["anthropic:subscription", "anthropic:api"]
    }
  },
  agent: {
    workspace: "~/clawd",
    // Model name is the same regardless of which auth method is used
    model: {
      primary: "anthropic/claude-sonnet-4-5",
      fallbacks: ["anthropic/claude-opus-4-5"]
    },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "sonnet" },
      "anthropic/claude-opus-4-5": { alias: "opus" }
    }
  }
}
```

### Work Bot (Restricted Access)
```json5
{
  identity: {
    name: "WorkBot",
    theme: "professional assistant"
  },
  agent: {
    workspace: "~/work-clawd",
    elevated: {
      enabled: false  // Disable privileged ops for safety
    }
  },
  slack: {
    enabled: true,
    botToken: "xoxb-...",
    channels: {
      "#engineering": { allow: true, requireMention: true },
      "#general": { allow: true, requireMention: true }
    }
  }
}
```

### Local Models Only
```json5
{
  agent: {
    workspace: "~/clawd",
    model: {
      primary: "lmstudio/minimax-m2.1-gs32"
    }
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192
          }
        ]
      }
    }
  }
}
```

---

## Next Steps

1. Start with the [Recommended Starting Config](#recommended-starting-config-10-lines)
2. Add platform integrations as needed (see [WhatsApp](whatsapp.md), [Telegram](telegram.md), [Discord](discord.md))
3. Customize identity and behavior
4. Explore advanced features when you're comfortable

For detailed explanations of each section, see the [complete configuration reference](configuration.md).

---

## Troubleshooting

**"My config isn't loading!"**
- Check file location: `~/.clawdbot/clawdbot.json`
- Validate JSON syntax (use [jsonlint.com](https://jsonlint.com) if needed)
- Check logs: `clawdbot doctor` or look in `~/.clawdbot/logs/`

**"Bot isn't responding in WhatsApp groups"**
- Make sure `groups: { "*": { requireMention: true } }` is set
- Add mention patterns: `routing.groupChat.mentionPatterns: ["@clawd"]`

**"Permission denied errors"**
- Check `agent.workspace` path exists and is writable
- Review `elevated.allowFrom` - you might not have elevated permissions

**"Can't connect to Telegram/Discord"**
- Verify tokens are correct (no quotes/spaces)
- Check network connectivity
- Look for error messages in logs

For more help, see [Troubleshooting](troubleshooting.md) or [FAQ](faq.md).
