<overview>
Start with pure primitives: bash, file operations, basic storage. This proves the architecture works and reveals what the agent actually needs. As patterns emerge, add domain-specific tools deliberately. This document covers when and how to evolve from primitives to domain tools, and when to graduate to optimized code.
</overview>

<start_with_primitives>
## Start with Pure Primitives

Begin every agent-native system with the most atomic tools possible:

- `read_file` / `write_file` / `list_files`
- `bash` (for everything else)
- Basic storage (`store_item` / `get_item`)
- HTTP requests (`fetch_url`)

**Why start here:**

1. **Proves the architecture** - If it works with primitives, your prompts are doing their job
2. **Reveals actual needs** - You'll discover what domain concepts matter
3. **Maximum flexibility** - Agent can do anything, not just what you anticipated
4. **Forces good prompts** - You can't lean on tool logic as a crutch

### Example: Starting Primitive

```typescript
// Start with just these
const tools = [
  tool("read_file", { path: z.string() }, ...),
  tool("write_file", { path: z.string(), content: z.string() }, ...),
  tool("list_files", { path: z.string() }, ...),
  tool("bash", { command: z.string() }, ...),
];

// Prompt handles the domain logic
const prompt = `
When processing feedback:
1. Read existing feedback from data/feedback.json
2. Add the new feedback with your assessment of importance (1-5)
3. Write the updated file
4. If importance >= 4, create a notification file in data/alerts/
`;
```
</start_with_primitives>

<when_to_add_domain_tools>
## When to Add Domain Tools

As patterns emerge, you'll want to add domain-specific tools. This is good—but do it deliberately.

### Vocabulary Anchoring

**Add a domain tool when:** The agent needs to understand domain concepts.

A `create_note` tool teaches the agent what "note" means in your system better than "write a file to the notes directory with this format."

```typescript
// Without domain tool - agent must infer structure
await agent.chat("Create a note about the meeting");
// Agent: writes to... notes/? documents/? what format?

// With domain tool - vocabulary is anchored
tool("create_note", {
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()).optional(),
}, async ({ title, content, tags }) => {
  // Tool enforces structure, agent understands "note"
});
```

### Guardrails

**Add a domain tool when:** Some operations need validation or constraints that shouldn't be left to agent judgment.

```typescript
// publish_to_feed might enforce format requirements or content policies
tool("publish_to_feed", {
  bookId: z.string(),
  content: z.string(),
  headline: z.string().max(100),  // Enforce headline length
}, async ({ bookId, content, headline }) => {
  // Validate content meets guidelines
  if (containsProhibitedContent(content)) {
    return { text: "Content doesn't meet guidelines", isError: true };
  }
  // Enforce proper structure
  await feedService.publish({ bookId, content, headline, publishedAt: new Date() });
});
```

### Efficiency

**Add a domain tool when:** Common operations would take many primitive calls.

```typescript
// Primitive approach: multiple calls
await agent.chat("Get book details");
// Agent: read library.json, parse, find book, read full_text.txt, read introduction.md...

// Domain tool: one call for common operation
tool("get_book_with_content", { bookId: z.string() }, async ({ bookId }) => {
  const book = await library.getBook(bookId);
  const fullText = await readFile(`Research/${bookId}/full_text.txt`);
  const intro = await readFile(`Research/${bookId}/introduction.md`);
  return { text: JSON.stringify({ book, fullText, intro }) };
});
```
</when_to_add_domain_tools>

<the_rule>
## The Rule for Domain Tools

**Domain tools should represent one conceptual action from the user's perspective.**

They can include mechanical validation, but **judgment about what to do or whether to do it belongs in the prompt**.

### Wrong: Bundles Judgment

```typescript
// WRONG - analyze_and_publish bundles judgment into the tool
tool("analyze_and_publish", async ({ input }) => {
  const analysis = analyzeContent(input);      // Tool decides how to analyze
  const shouldPublish = analysis.score > 0.7;  // Tool decides whether to publish
  if (shouldPublish) {
    await publish(analysis.summary);            // Tool decides what to publish
  }
});
```

### Right: One Action, Agent Decides

```typescript
// RIGHT - separate tools, agent decides
tool("analyze_content", { content: z.string() }, ...);  // Returns analysis
tool("publish", { content: z.string() }, ...);          // Publishes what agent provides

// Prompt: "Analyze the content. If it's high quality, publish a summary."
// Agent decides what "high quality" means and what summary to write.
```

### The Test

Ask: "Who is making the decision here?"

- If the answer is "the tool code" → you've encoded judgment, refactor
- If the answer is "the agent based on the prompt" → good
</the_rule>

<keep_primitives_available>
## Keep Primitives Available

**Domain tools are shortcuts, not gates.**

Unless there's a specific reason to restrict access (security, data integrity), the agent should still be able to use underlying primitives for edge cases.

```typescript
// Domain tool for common case
tool("create_note", { title, content }, ...);

// But primitives still available for edge cases
tool("read_file", { path }, ...);
tool("write_file", { path, content }, ...);

// Agent can use create_note normally, but for weird edge case:
// "Create a note in a non-standard location with custom metadata"
// → Agent uses write_file directly
```

### When to Gate

Gating (making domain tool the only way) is appropriate for:

- **Security:** User authentication, payment processing
- **Data integrity:** Operations that must maintain invariants
- **Audit requirements:** Actions that must be logged in specific ways

**The default is open.** When you do gate something, make it a conscious decision with a clear reason.
</keep_primitives_available>

<graduating_to_code>
## Graduating to Code

Some operations will need to move from agent-orchestrated to optimized code for performance or reliability.

### The Progression

```
Stage 1: Agent uses primitives in a loop
         → Flexible, proves the concept
         → Slow, potentially expensive

Stage 2: Add domain tools for common operations
         → Faster, still agent-orchestrated
         → Agent still decides when/whether to use

Stage 3: For hot paths, implement in optimized code
         → Fast, deterministic
         → Agent can still trigger, but execution is code
```

### Example Progression

**Stage 1: Pure primitives**
```markdown
Prompt: "When user asks for a summary, read all notes in /notes,
        analyze them, and write a summary to /summaries/{date}.md"

Agent: Calls read_file 20 times, reasons about content, writes summary
Time: 30 seconds, 50k tokens
```

**Stage 2: Domain tool**
```typescript
tool("get_all_notes", {}, async () => {
  const notes = await readAllNotesFromDirectory();
  return { text: JSON.stringify(notes) };
});

// Agent still decides how to summarize, but retrieval is faster
// Time: 10 seconds, 30k tokens
```

**Stage 3: Optimized code**
```typescript
tool("generate_weekly_summary", {}, async () => {
  // Entire operation in code for hot path
  const notes = await getNotes({ since: oneWeekAgo });
  const summary = await generateSummary(notes);  // Could use cheaper model
  await writeSummary(summary);
  return { text: "Summary generated" };
});

// Agent just triggers it
// Time: 2 seconds, 5k tokens
```

### The Caveat

**Even when an operation graduates to code, the agent should be able to:**

1. Trigger the optimized operation itself
2. Fall back to primitives for edge cases the optimized path doesn't handle

Graduation is about efficiency. **Parity still holds.** The agent doesn't lose capability when you optimize.
</graduating_to_code>

<decision_framework>
## Decision Framework

### Should I Add a Domain Tool?

| Question | If Yes |
|----------|--------|
| Is the agent confused about what this concept means? | Add for vocabulary anchoring |
| Does this operation need validation the agent shouldn't decide? | Add with guardrails |
| Is this a common multi-step operation? | Add for efficiency |
| Would changing behavior require code changes? | Keep as prompt instead |

### Should I Graduate to Code?

| Question | If Yes |
|----------|--------|
| Is this operation called very frequently? | Consider graduating |
| Does latency matter significantly? | Consider graduating |
| Are token costs problematic? | Consider graduating |
| Do you need deterministic behavior? | Graduate to code |
| Does the operation need complex state management? | Graduate to code |

### Should I Gate Access?

| Question | If Yes |
|----------|--------|
| Is there a security requirement? | Gate appropriately |
| Must this operation maintain data integrity? | Gate appropriately |
| Is there an audit/compliance requirement? | Gate appropriately |
| Is it just "safer" with no specific risk? | Keep primitives available |
</decision_framework>

<examples>
## Examples

### Feedback Processing Evolution

**Stage 1: Primitives only**
```typescript
tools: [read_file, write_file, bash]
prompt: "Store feedback in data/feedback.json, notify if important"
// Agent figures out JSON structure, importance criteria, notification method
```

**Stage 2: Domain tools for vocabulary**
```typescript
tools: [
  store_feedback,      // Anchors "feedback" concept with proper structure
  send_notification,   // Anchors "notify" with correct channels
  read_file,           // Still available for edge cases
  write_file,
]
prompt: "Store feedback using store_feedback. Notify if importance >= 4."
// Agent still decides importance, but vocabulary is anchored
```

**Stage 3: Graduated hot path**
```typescript
tools: [
  process_feedback_batch,  // Optimized for high-volume processing
  store_feedback,          // For individual items
  send_notification,
  read_file,
  write_file,
]
// Batch processing is code, but agent can still use store_feedback for special cases
```

### When NOT to Add Domain Tools

**Don't add a domain tool just to make things "cleaner":**
```typescript
// Unnecessary - agent can compose primitives
tool("organize_files_by_date", ...)  // Just use move_file + judgment

// Unnecessary - puts decision in wrong place
tool("decide_file_importance", ...)  // This is prompt territory
```

**Don't add a domain tool if behavior might change:**
```typescript
// Bad - locked into code
tool("generate_standard_report", ...)  // What if report format evolves?

// Better - keep in prompt
prompt: "Generate a report covering X, Y, Z. Format for readability."
// Can adjust format by editing prompt
```
</examples>

<checklist>
## Checklist: Primitives to Domain Tools

### Starting Out
- [ ] Begin with pure primitives (read, write, list, bash)
- [ ] Write behavior in prompts, not tool logic
- [ ] Let patterns emerge from actual usage

### Adding Domain Tools
- [ ] Clear reason: vocabulary anchoring, guardrails, or efficiency
- [ ] Tool represents one conceptual action
- [ ] Judgment stays in prompts, not tool code
- [ ] Primitives remain available alongside domain tools

### Graduating to Code
- [ ] Hot path identified (frequent, latency-sensitive, or expensive)
- [ ] Optimized version doesn't remove agent capability
- [ ] Fallback to primitives for edge cases still works

### Gating Decisions
- [ ] Specific reason for each gate (security, integrity, audit)
- [ ] Default is open access
- [ ] Gates are conscious decisions, not defaults
</checklist>
