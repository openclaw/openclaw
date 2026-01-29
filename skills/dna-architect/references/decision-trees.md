# Extension System Decision Trees

## Master Decision Tree

```
START: "I need to add/change something in DNA"
│
├─► Is it DOCUMENTATION for the agent?
│   │
│   ├─► YES: Does it need to react to events?
│   │   │
│   │   ├─► YES → Consider HOOK + SKILL combo
│   │   │
│   │   └─► NO → Use SKILL
│   │       │
│   │       ├─► Simple instructions? → SKILL.md only
│   │       ├─► Need automation? → Add scripts/
│   │       └─► Need examples? → Add references/
│   │
│   └─► NO: Continue below ▼
│
├─► Does it need to RUN CODE at specific times?
│   │
│   ├─► On agent events (bootstrap, /new)?
│   │   └─► Use HOOK
│   │
│   ├─► On a schedule (daily, hourly)?
│   │   │
│   │   ├─► Exact time matters? → Use CRON
│   │   └─► Rough interval OK? → Use HEARTBEAT
│   │
│   ├─► On external trigger?
│   │   └─► Use WEBHOOK
│   │
│   └─► Continuously in background?
│       └─► Use PLUGIN (service)
│
├─► Does it ADD NEW CAPABILITIES to the agent?
│   │
│   ├─► New tool function?
│   │   └─► Use PLUGIN + TOOL
│   │
│   ├─► New CLI command?
│   │   └─► Use PLUGIN
│   │
│   ├─► New chat platform?
│   │   └─► Use PLUGIN (channel)
│   │
│   └─► New AI model?
│       └─► Configure PROVIDER
│
└─► Does it involve REMOTE DEVICES?
    │
    ├─► Existing node capability? → Use NODES tool
    │
    └─► New node capability? → Modify node app
```

## Skill vs Hook vs Plugin

```
┌────────────────────────────────────────────────────────────────┐
│                        SKILL                                    │
├────────────────────────────────────────────────────────────────┤
│ ✓ Teaches agent HOW to do something                            │
│ ✓ Loaded into context when relevant                            │
│ ✓ Can include scripts and references                           │
│ ✓ User-editable (workspace/skills/)                            │
│                                                                 │
│ ✗ Cannot run code on events                                    │
│ ✗ Cannot modify agent context programmatically                 │
│ ✗ Cannot add new tool functions                                │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│                        HOOK                                     │
├────────────────────────────────────────────────────────────────┤
│ ✓ Runs code when events fire                                   │
│ ✓ Can inject content into agent context                        │
│ ✓ Can read session state                                       │
│ ✓ No restart required                                          │
│                                                                 │
│ ✗ Cannot add new tools or commands                             │
│ ✗ Limited to predefined events                                 │
│ ✗ Runs in Gateway process (errors can affect stability)        │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│                        PLUGIN                                   │
├────────────────────────────────────────────────────────────────┤
│ ✓ Can add tools, commands, RPC, HTTP handlers                  │
│ ✓ Can bundle skills and hooks                                  │
│ ✓ Can run background services                                  │
│ ✓ Full Gateway API access                                      │
│                                                                 │
│ ✗ Requires Gateway restart to load                             │
│ ✗ Runs in-process (must be trusted)                            │
│ ✗ More complex to develop and maintain                         │
└────────────────────────────────────────────────────────────────┘
```

## Cron vs Heartbeat

```
┌─────────────────────────────────────────────────────────────────┐
│                          CRON                                    │
├─────────────────────────────────────────────────────────────────┤
│ USE WHEN:                                                        │
│ • Exact timing matters ("9 AM every Monday")                    │
│ • Task needs isolation from main session                        │
│ • Different model or thinking level needed                      │
│ • One-shot reminders ("in 20 minutes")                          │
│ • Output should go to specific channel                          │
│                                                                  │
│ CHARACTERISTICS:                                                 │
│ • Persists across restarts                                      │
│ • Can target isolated or main session                           │
│ • Supports cron expressions, intervals, timestamps              │
│ • Each job has dedicated context                                │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        HEARTBEAT                                 │
├─────────────────────────────────────────────────────────────────┤
│ USE WHEN:                                                        │
│ • Multiple checks can batch together                            │
│ • Need recent conversation context                              │
│ • Timing can drift ("roughly every 30 min")                     │
│ • Reducing API calls by combining periodic tasks                │
│                                                                  │
│ CHARACTERISTICS:                                                 │
│ • Runs in main session context                                  │
│ • Controlled by HEARTBEAT.md                                    │
│ • Can be skipped with HEARTBEAT_OK                              │
│ • Good for batching: email + calendar + weather                 │
└─────────────────────────────────────────────────────────────────┘
```

## Tool Access Patterns

```
MINIMAL ACCESS (support agent, read-only)
├── session_status
└── No file/exec access

MESSAGING ACCESS (notification agent)
├── message (send)
├── sessions_list, sessions_history, sessions_send
└── session_status

CODING ACCESS (dev agent)
├── group:fs (read, write, edit)
├── group:runtime (exec, process)
├── group:sessions
├── group:memory
└── image

FULL ACCESS (main agent)
└── All tools available
```
