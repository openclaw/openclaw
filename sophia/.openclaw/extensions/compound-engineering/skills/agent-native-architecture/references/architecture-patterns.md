<overview>
Architectural patterns for building agent-native systems. These patterns emerge from the five core principles: Parity, Granularity, Composability, Emergent Capability, and Improvement Over Time.

Features are outcomes achieved by agents operating in a loop, not functions you write. Tools are atomic primitives. The agent applies judgment; the prompt defines the outcome.

See also:
- [files-universal-interface.md](./files-universal-interface.md) for file organization and context.md patterns
- [agent-execution-patterns.md](./agent-execution-patterns.md) for completion signals and partial completion
- [product-implications.md](./product-implications.md) for progressive disclosure and approval patterns
</overview>

<pattern name="event-driven-agent">
## Event-Driven Agent Architecture

The agent runs as a long-lived process that responds to events. Events become prompts.

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Loop                                │
├─────────────────────────────────────────────────────────────┤
│  Event Source → Agent (Claude) → Tool Calls → Response      │
└─────────────────────────────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
    ┌─────────┐    ┌──────────┐    ┌───────────┐
    │ Content │    │   Self   │    │   Data    │
    │  Tools  │    │  Tools   │    │   Tools   │
    └─────────┘    └──────────┘    └───────────┘
    (write_file)   (read_source)   (store_item)
                   (restart)       (list_items)
```

**Key characteristics:**
- Events (messages, webhooks, timers) trigger agent turns
- Agent decides how to respond based on system prompt
- Tools are primitives for IO, not business logic
- State persists between events via data tools

**Example: Discord feedback bot**
```typescript
// Event source
client.on("messageCreate", (message) => {
  if (!message.author.bot) {
    runAgent({
      userMessage: `New message from ${message.author}: "${message.content}"`,
      channelId: message.channelId,
    });
  }
});

// System prompt defines behavior
const systemPrompt = `
When someone shares feedback:
1. Acknowledge their feedback warmly
2. Ask clarifying questions if needed
3. Store it using the feedback tools
4. Update the feedback site

Use your judgment about importance and categorization.
`;
```
</pattern>

<pattern name="two-layer-git">
## Two-Layer Git Architecture

For self-modifying agents, separate code (shared) from data (instance-specific).

```
┌─────────────────────────────────────────────────────────────┐
│                     GitHub (shared repo)                     │
│  - src/           (agent code)                              │
│  - site/          (web interface)                           │
│  - package.json   (dependencies)                            │
│  - .gitignore     (excludes data/, logs/)                   │
└─────────────────────────────────────────────────────────────┘
                          │
                     git clone
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                  Instance (Server)                           │
│                                                              │
│  FROM GITHUB (tracked):                                      │
│  - src/           → pushed back on code changes             │
│  - site/          → pushed, triggers deployment             │
│                                                              │
│  LOCAL ONLY (untracked):                                     │
│  - data/          → instance-specific storage               │
│  - logs/          → runtime logs                            │
│  - .env           → secrets                                 │
└─────────────────────────────────────────────────────────────┘
```

**Why this works:**
- Code and site are version controlled (GitHub)
- Raw data stays local (instance-specific)
- Site is generated from data, so reproducible
- Automatic rollback via git history
</pattern>

<pattern name="multi-instance">
## Multi-Instance Branching

Each agent instance gets its own branch while sharing core code.

```
main                        # Shared features, bug fixes
├── instance/feedback-bot   # Every Reader feedback bot
├── instance/support-bot    # Customer support bot
└── instance/research-bot   # Research assistant
```

**Change flow:**
| Change Type | Work On | Then |
|-------------|---------|------|
| Core features | main | Merge to instance branches |
| Bug fixes | main | Merge to instance branches |
| Instance config | instance branch | Done |
| Instance data | instance branch | Done |

**Sync tools:**
```typescript
tool("self_deploy", "Pull latest from main, rebuild, restart", ...)
tool("sync_from_instance", "Merge from another instance", ...)
tool("propose_to_main", "Create PR to share improvements", ...)
```
</pattern>

<pattern name="site-as-output">
## Site as Agent Output

The agent generates and maintains a website as a natural output, not through specialized site tools.

```
Discord Message
      ↓
Agent processes it, extracts insights
      ↓
Agent decides what site updates are needed
      ↓
Agent writes files using write_file primitive
      ↓
Git commit + push triggers deployment
      ↓
Site updates automatically
```

**Key insight:** Don't build site generation tools. Give the agent file tools and teach it in the prompt how to create good sites.

```markdown
## Site Management

You maintain a public feedback site. When feedback comes in:
1. Use write_file to update site/public/content/feedback.json
2. If the site's React components need improvement, modify them
3. Commit changes and push to trigger Vercel deploy

The site should be:
- Clean, modern dashboard aesthetic
- Clear visual hierarchy
- Status organization (Inbox, Active, Done)

You decide the structure. Make it good.
```
</pattern>

<pattern name="approval-gates">
## Approval Gates Pattern

Separate "propose" from "apply" for dangerous operations.

```typescript
// Pending changes stored separately
const pendingChanges = new Map<string, string>();

tool("write_file", async ({ path, content }) => {
  if (requiresApproval(path)) {
    // Store for approval
    pendingChanges.set(path, content);
    const diff = generateDiff(path, content);
    return {
      text: `Change requires approval.\n\n${diff}\n\nReply "yes" to apply.`
    };
  } else {
    // Apply immediately
    writeFileSync(path, content);
    return { text: `Wrote ${path}` };
  }
});

tool("apply_pending", async () => {
  for (const [path, content] of pendingChanges) {
    writeFileSync(path, content);
  }
  pendingChanges.clear();
  return { text: "Applied all pending changes" };
});
```

**What requires approval:**
- src/*.ts (agent code)
- package.json (dependencies)
- system prompt changes

**What doesn't:**
- data/* (instance data)
- site/* (generated content)
- docs/* (documentation)
</pattern>

<pattern name="unified-agent-architecture">
## Unified Agent Architecture

One execution engine, many agent types. All agents use the same orchestrator but with different configurations.

```
┌─────────────────────────────────────────────────────────────┐
│                    AgentOrchestrator                         │
├─────────────────────────────────────────────────────────────┤
│  - Lifecycle management (start, pause, resume, stop)        │
│  - Checkpoint/restore (for background execution)            │
│  - Tool execution                                            │
│  - Chat integration                                          │
└─────────────────────────────────────────────────────────────┘
          │                    │                    │
    ┌─────┴─────┐        ┌─────┴─────┐        ┌─────┴─────┐
    │ Research  │        │   Chat    │        │  Profile  │
    │   Agent   │        │   Agent   │        │   Agent   │
    └───────────┘        └───────────┘        └───────────┘
    - web_search         - read_library       - read_photos
    - write_file         - publish_to_feed    - write_file
    - read_file          - web_search         - analyze_image
```

**Implementation:**

```swift
// All agents use the same orchestrator
let session = try await AgentOrchestrator.shared.startAgent(
    config: ResearchAgent.create(book: book),  // Config varies
    tools: ResearchAgent.tools,                 // Tools vary
    context: ResearchAgent.context(for: book)   // Context varies
)

// Agent types define their own configuration
struct ResearchAgent {
    static var tools: [AgentTool] {
        [
            FileTools.readFile(),
            FileTools.writeFile(),
            WebTools.webSearch(),
            WebTools.webFetch(),
        ]
    }

    static func context(for book: Book) -> String {
        """
        You are researching "\(book.title)" by \(book.author).
        Save findings to Documents/Research/\(book.id)/
        """
    }
}

struct ChatAgent {
    static var tools: [AgentTool] {
        [
            FileTools.readFile(),
            FileTools.writeFile(),
            BookTools.readLibrary(),
            BookTools.publishToFeed(),  // Chat can publish directly
            WebTools.webSearch(),
        ]
    }

    static func context(library: [Book]) -> String {
        """
        You help the user with their reading.
        Available books: \(library.map { $0.title }.joined(separator: ", "))
        """
    }
}
```

**Benefits:**
- Consistent lifecycle management across all agent types
- Automatic checkpoint/resume (critical for mobile)
- Shared tool protocol
- Easy to add new agent types
- Centralized error handling and logging
</pattern>

<pattern name="agent-to-ui-communication">
## Agent-to-UI Communication

When agents take actions, the UI should reflect them immediately. The user should see what the agent did.

**Pattern 1: Shared Data Store (Recommended)**

Agent writes through the same service the UI observes:

```swift
// Shared service
class BookLibraryService: ObservableObject {
    static let shared = BookLibraryService()
    @Published var books: [Book] = []
    @Published var feedItems: [FeedItem] = []

    func addFeedItem(_ item: FeedItem) {
        feedItems.append(item)
        persist()
    }
}

// Agent tool writes through shared service
tool("publish_to_feed", async ({ bookId, content, headline }) => {
    let item = FeedItem(bookId: bookId, content: content, headline: headline)
    BookLibraryService.shared.addFeedItem(item)  // Same service UI uses
    return { text: "Published to feed" }
})

// UI observes the same service
struct FeedView: View {
    @StateObject var library = BookLibraryService.shared

    var body: some View {
        List(library.feedItems) { item in
            FeedItemRow(item: item)
            // Automatically updates when agent adds items
        }
    }
}
```

**Pattern 2: File System Observation**

For file-based data, watch the file system:

```swift
class ResearchWatcher: ObservableObject {
    @Published var files: [URL] = []
    private var watcher: DirectoryWatcher?

    func watch(bookId: String) {
        let path = documentsURL.appendingPathComponent("Research/\(bookId)")

        watcher = DirectoryWatcher(path: path) { [weak self] in
            self?.reload(from: path)
        }

        reload(from: path)
    }
}

// Agent writes files
tool("write_file", { path, content }) -> {
    writeFile(documentsURL.appendingPathComponent(path), content)
    // DirectoryWatcher triggers UI update automatically
}
```

**Pattern 3: Event Bus (Cross-Component)**

For complex apps with multiple independent components:

```typescript
// Shared event bus
const agentEvents = new EventEmitter();

// Agent tool emits events
tool("publish_to_feed", async ({ content }) => {
    const item = await feedService.add(content);
    agentEvents.emit('feed:new-item', item);
    return { text: "Published" };
});

// UI components subscribe
function FeedView() {
    const [items, setItems] = useState([]);

    useEffect(() => {
        const handler = (item) => setItems(prev => [...prev, item]);
        agentEvents.on('feed:new-item', handler);
        return () => agentEvents.off('feed:new-item', handler);
    }, []);

    return <FeedList items={items} />;
}
```

**What to avoid:**

```swift
// BAD: UI doesn't observe agent changes
// Agent writes to database directly
tool("publish_to_feed", { content }) {
    database.insert("feed", content)  // UI doesn't see this
}

// UI loads once at startup, never refreshes
struct FeedView: View {
    let items = database.query("feed")  // Stale!
}
```
</pattern>

<pattern name="model-tier-selection">
## Model Tier Selection

Different agents need different intelligence levels. Use the cheapest model that achieves the outcome.

| Agent Type | Recommended Tier | Reasoning |
|------------|-----------------|-----------|
| Chat/Conversation | Balanced | Fast responses, good reasoning |
| Research | Balanced | Tool loops, not ultra-complex synthesis |
| Content Generation | Balanced | Creative but not synthesis-heavy |
| Complex Analysis | Powerful | Multi-document synthesis, nuanced judgment |
| Profile/Onboarding | Powerful | Photo analysis, complex pattern recognition |
| Simple Queries | Fast/Haiku | Quick lookups, simple transformations |

**Implementation:**

```swift
enum ModelTier {
    case fast      // claude-3-haiku: Quick, cheap, simple tasks
    case balanced  // claude-3-sonnet: Good balance for most tasks
    case powerful  // claude-3-opus: Complex reasoning, synthesis
}

struct AgentConfig {
    let modelTier: ModelTier
    let tools: [AgentTool]
    let systemPrompt: String
}

// Research agent: balanced tier
let researchConfig = AgentConfig(
    modelTier: .balanced,
    tools: researchTools,
    systemPrompt: researchPrompt
)

// Profile analysis: powerful tier (complex photo interpretation)
let profileConfig = AgentConfig(
    modelTier: .powerful,
    tools: profileTools,
    systemPrompt: profilePrompt
)

// Quick lookup: fast tier
let lookupConfig = AgentConfig(
    modelTier: .fast,
    tools: [readLibrary],
    systemPrompt: "Answer quick questions about the user's library."
)
```

**Cost optimization strategies:**
- Start with balanced tier, only upgrade if quality insufficient
- Use fast tier for tool-heavy loops where each turn is simple
- Reserve powerful tier for synthesis tasks (comparing multiple sources)
- Consider token limits per turn to control costs
</pattern>

<design_questions>
## Questions to Ask When Designing

1. **What events trigger agent turns?** (messages, webhooks, timers, user requests)
2. **What primitives does the agent need?** (read, write, call API, restart)
3. **What decisions should the agent make?** (format, structure, priority, action)
4. **What decisions should be hardcoded?** (security boundaries, approval requirements)
5. **How does the agent verify its work?** (health checks, build verification)
6. **How does the agent recover from mistakes?** (git rollback, approval gates)
7. **How does the UI know when agent changes state?** (shared store, file watching, events)
8. **What model tier does each agent type need?** (fast, balanced, powerful)
9. **How do agents share infrastructure?** (unified orchestrator, shared tools)
</design_questions>
