<overview>
How to inject dynamic runtime context into agent system prompts. The agent needs to know what exists in the app to know what it can work with. Static prompts aren't enough—the agent needs to see the same context the user sees.

**Core principle:** The user's context IS the agent's context.
</overview>

<why_context_matters>
## Why Dynamic Context Injection?

A static system prompt tells the agent what it CAN do. Dynamic context tells it what it can do RIGHT NOW with the user's actual data.

**The failure case:**
```
User: "Write a little thing about Catherine the Great in my reading feed"
Agent: "What system are you referring to? I'm not sure what reading feed means."
```

The agent failed because it didn't know:
- What books exist in the user's library
- What the "reading feed" is
- What tools it has to publish there

**The fix:** Inject runtime context about app state into the system prompt.
</why_context_matters>

<pattern name="context-injection">
## The Context Injection Pattern

Build your system prompt dynamically, including current app state:

```swift
func buildSystemPrompt() -> String {
    // Gather current state
    let availableBooks = libraryService.books
    let recentActivity = analysisService.recentRecords(limit: 10)
    let userProfile = profileService.currentProfile

    return """
    # Your Identity

    You are a reading assistant for \(userProfile.name)'s library.

    ## Available Books in User's Library

    \(availableBooks.map { "- \"\($0.title)\" by \($0.author) (id: \($0.id))" }.joined(separator: "\n"))

    ## Recent Reading Activity

    \(recentActivity.map { "- Analyzed \"\($0.bookTitle)\": \($0.excerptPreview)" }.joined(separator: "\n"))

    ## Your Capabilities

    - **publish_to_feed**: Create insights that appear in the Feed tab
    - **read_library**: View books, highlights, and analyses
    - **web_search**: Search the internet for research
    - **write_file**: Save research to Documents/Research/{bookId}/

    When the user mentions "the feed" or "reading feed", they mean the Feed tab
    where insights appear. Use `publish_to_feed` to create content there.
    """
}
```
</pattern>

<what_to_inject>
## What Context to Inject

### 1. Available Resources
What data/files exist that the agent can access?

```swift
## Available in User's Library

Books:
- "Moby Dick" by Herman Melville (id: book_123)
- "1984" by George Orwell (id: book_456)

Research folders:
- Documents/Research/book_123/ (3 files)
- Documents/Research/book_456/ (1 file)
```

### 2. Current State
What has the user done recently? What's the current context?

```swift
## Recent Activity

- 2 hours ago: Highlighted passage in "1984" about surveillance
- Yesterday: Completed research on "Moby Dick" whale symbolism
- This week: Added 3 new books to library
```

### 3. Capabilities Mapping
What tool maps to what UI feature? Use the user's language.

```swift
## What You Can Do

| User Says | You Should Use | Result |
|-----------|----------------|--------|
| "my feed" / "reading feed" | `publish_to_feed` | Creates insight in Feed tab |
| "my library" / "my books" | `read_library` | Shows their book collection |
| "research this" | `web_search` + `write_file` | Saves to Research folder |
| "my profile" | `read_file("profile.md")` | Shows reading profile |
```

### 4. Domain Vocabulary
Explain app-specific terms the user might use.

```swift
## Vocabulary

- **Feed**: The Feed tab showing reading insights and analyses
- **Research folder**: Documents/Research/{bookId}/ where research is stored
- **Reading profile**: A markdown file describing user's reading preferences
- **Highlight**: A passage the user marked in a book
```
</what_to_inject>

<implementation_patterns>
## Implementation Patterns

### Pattern 1: Service-Based Injection (Swift/iOS)

```swift
class AgentContextBuilder {
    let libraryService: BookLibraryService
    let profileService: ReadingProfileService
    let activityService: ActivityService

    func buildContext() -> String {
        let books = libraryService.books
        let profile = profileService.currentProfile
        let activity = activityService.recent(limit: 10)

        return """
        ## Library (\(books.count) books)
        \(formatBooks(books))

        ## Profile
        \(profile.summary)

        ## Recent Activity
        \(formatActivity(activity))
        """
    }

    private func formatBooks(_ books: [Book]) -> String {
        books.map { "- \"\($0.title)\" (id: \($0.id))" }.joined(separator: "\n")
    }
}

// Usage in agent initialization
let context = AgentContextBuilder(
    libraryService: .shared,
    profileService: .shared,
    activityService: .shared
).buildContext()

let systemPrompt = basePrompt + "\n\n" + context
```

### Pattern 2: Hook-Based Injection (TypeScript)

```typescript
interface ContextProvider {
  getContext(): Promise<string>;
}

class LibraryContextProvider implements ContextProvider {
  async getContext(): Promise<string> {
    const books = await db.books.list();
    const recent = await db.activity.recent(10);

    return `
## Library
${books.map(b => `- "${b.title}" (${b.id})`).join('\n')}

## Recent
${recent.map(r => `- ${r.description}`).join('\n')}
    `.trim();
  }
}

// Compose multiple providers
async function buildSystemPrompt(providers: ContextProvider[]): Promise<string> {
  const contexts = await Promise.all(providers.map(p => p.getContext()));
  return [BASE_PROMPT, ...contexts].join('\n\n');
}
```

### Pattern 3: Template-Based Injection

```markdown
# System Prompt Template (system-prompt.template.md)

You are a reading assistant.

## Available Books

{{#each books}}
- "{{title}}" by {{author}} (id: {{id}})
{{/each}}

## Capabilities

{{#each capabilities}}
- **{{name}}**: {{description}}
{{/each}}

## Recent Activity

{{#each recentActivity}}
- {{timestamp}}: {{description}}
{{/each}}
```

```typescript
// Render at runtime
const prompt = Handlebars.compile(template)({
  books: await libraryService.getBooks(),
  capabilities: getCapabilities(),
  recentActivity: await activityService.getRecent(10),
});
```
</implementation_patterns>

<context_freshness>
## Context Freshness

Context should be injected at agent initialization, and optionally refreshed during long sessions.

**At initialization:**
```swift
// Always inject fresh context when starting an agent
func startChatAgent() async -> AgentSession {
    let context = await buildCurrentContext()  // Fresh context
    return await AgentOrchestrator.shared.startAgent(
        config: ChatAgent.config,
        systemPrompt: basePrompt + context
    )
}
```

**During long sessions (optional):**
```swift
// For long-running agents, provide a refresh tool
tool("refresh_context", "Get current app state") { _ in
    let books = libraryService.books
    let recent = activityService.recent(10)
    return """
    Current library: \(books.count) books
    Recent: \(recent.map { $0.summary }.joined(separator: ", "))
    """
}
```

**What NOT to do:**
```swift
// DON'T: Use stale context from app launch
let cachedContext = appLaunchContext  // Stale!
// Books may have been added, activity may have changed
```
</context_freshness>

<examples>
## Real-World Example: Every Reader

The Every Reader app injects context for its chat agent:

```swift
func getChatAgentSystemPrompt() -> String {
    // Get current library state
    let books = BookLibraryService.shared.books
    let analyses = BookLibraryService.shared.analysisRecords.prefix(10)
    let profile = ReadingProfileService.shared.getProfileForSystemPrompt()

    let bookList = books.map { book in
        "- \"\(book.title)\" by \(book.author) (id: \(book.id))"
    }.joined(separator: "\n")

    let recentList = analyses.map { record in
        let title = books.first { $0.id == record.bookId }?.title ?? "Unknown"
        return "- From \"\(title)\": \"\(record.excerptPreview)\""
    }.joined(separator: "\n")

    return """
    # Reading Assistant

    You help the user with their reading and book research.

    ## Available Books in User's Library

    \(bookList.isEmpty ? "No books yet." : bookList)

    ## Recent Reading Journal (Latest Analyses)

    \(recentList.isEmpty ? "No analyses yet." : recentList)

    ## Reading Profile

    \(profile)

    ## Your Capabilities

    - **Publish to Feed**: Create insights using `publish_to_feed` that appear in the Feed tab
    - **Library Access**: View books and highlights using `read_library`
    - **Research**: Search web and save to Documents/Research/{bookId}/
    - **Profile**: Read/update the user's reading profile

    When the user asks you to "write something for their feed" or "add to my reading feed",
    use the `publish_to_feed` tool with the relevant book_id.
    """
}
```

**Result:** When user says "write a little thing about Catherine the Great in my reading feed", the agent:
1. Sees "reading feed" → knows to use `publish_to_feed`
2. Sees available books → finds the relevant book ID
3. Creates appropriate content for the Feed tab
</examples>

<checklist>
## Context Injection Checklist

Before launching an agent:
- [ ] System prompt includes current resources (books, files, data)
- [ ] Recent activity is visible to the agent
- [ ] Capabilities are mapped to user vocabulary
- [ ] Domain-specific terms are explained
- [ ] Context is fresh (gathered at agent start, not cached)

When adding new features:
- [ ] New resources are included in context injection
- [ ] New capabilities are documented in system prompt
- [ ] User vocabulary for the feature is mapped
</checklist>
