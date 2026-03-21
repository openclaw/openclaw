<overview>
How to refactor existing agent code to follow prompt-native principles. The goal: move behavior from code into prompts, and simplify tools into primitives.
</overview>

<diagnosis>
## Diagnosing Non-Prompt-Native Code

Signs your agent isn't prompt-native:

**Tools that encode workflows:**
```typescript
// RED FLAG: Tool contains business logic
tool("process_feedback", async ({ message }) => {
  const category = categorize(message);        // Logic in code
  const priority = calculatePriority(message); // Logic in code
  await store(message, category, priority);    // Orchestration in code
  if (priority > 3) await notify();            // Decision in code
});
```

**Agent calls functions instead of figuring things out:**
```typescript
// RED FLAG: Agent is just a function caller
"Use process_feedback to handle incoming messages"
// vs.
"When feedback comes in, decide importance, store it, notify if high"
```

**Artificial limits on agent capability:**
```typescript
// RED FLAG: Tool prevents agent from doing what users can do
tool("read_file", async ({ path }) => {
  if (!ALLOWED_PATHS.includes(path)) {
    throw new Error("Not allowed to read this file");
  }
  return readFile(path);
});
```

**Prompts that specify HOW instead of WHAT:**
```markdown
// RED FLAG: Micromanaging the agent
When creating a summary:
1. Use exactly 3 bullet points
2. Each bullet must be under 20 words
3. Format with em-dashes for sub-points
4. Bold the first word of each bullet
```
</diagnosis>

<refactoring_workflow>
## Step-by-Step Refactoring

**Step 1: Identify workflow tools**

List all your tools. Mark any that:
- Have business logic (categorize, calculate, decide)
- Orchestrate multiple operations
- Make decisions on behalf of the agent
- Contain conditional logic (if/else based on content)

**Step 2: Extract the primitives**

For each workflow tool, identify the underlying primitives:

| Workflow Tool | Hidden Primitives |
|---------------|-------------------|
| `process_feedback` | `store_item`, `send_message` |
| `generate_report` | `read_file`, `write_file` |
| `deploy_and_notify` | `git_push`, `send_message` |

**Step 3: Move behavior to the prompt**

Take the logic from your workflow tools and express it in natural language:

```typescript
// Before (in code):
async function processFeedback(message) {
  const priority = message.includes("crash") ? 5 :
                   message.includes("bug") ? 4 : 3;
  await store(message, priority);
  if (priority >= 4) await notify();
}
```

```markdown
// After (in prompt):
## Feedback Processing

When someone shares feedback:
1. Rate importance 1-5:
   - 5: Crashes, data loss, security issues
   - 4: Bug reports with clear reproduction steps
   - 3: General suggestions, minor issues
2. Store using store_item
3. If importance >= 4, notify the team

Use your judgment. Context matters more than keywords.
```

**Step 4: Simplify tools to primitives**

```typescript
// Before: 1 workflow tool
tool("process_feedback", { message, category, priority }, ...complex logic...)

// After: 2 primitive tools
tool("store_item", { key: z.string(), value: z.any() }, ...simple storage...)
tool("send_message", { channel: z.string(), content: z.string() }, ...simple send...)
```

**Step 5: Remove artificial limits**

```typescript
// Before: Limited capability
tool("read_file", async ({ path }) => {
  if (!isAllowed(path)) throw new Error("Forbidden");
  return readFile(path);
});

// After: Full capability
tool("read_file", async ({ path }) => {
  return readFile(path);  // Agent can read anything
});
// Use approval gates for WRITES, not artificial limits on READS
```

**Step 6: Test with outcomes, not procedures**

Instead of testing "does it call the right function?", test "does it achieve the outcome?"

```typescript
// Before: Testing procedure
expect(mockProcessFeedback).toHaveBeenCalledWith(...)

// After: Testing outcome
// Send feedback → Check it was stored with reasonable importance
// Send high-priority feedback → Check notification was sent
```
</refactoring_workflow>

<before_after>
## Before/After Examples

**Example 1: Feedback Processing**

Before:
```typescript
tool("handle_feedback", async ({ message, author }) => {
  const category = detectCategory(message);
  const priority = calculatePriority(message, category);
  const feedbackId = await db.feedback.insert({
    id: generateId(),
    author,
    message,
    category,
    priority,
    timestamp: new Date().toISOString(),
  });

  if (priority >= 4) {
    await discord.send(ALERT_CHANNEL, `High priority feedback from ${author}`);
  }

  return { feedbackId, category, priority };
});
```

After:
```typescript
// Simple storage primitive
tool("store_feedback", async ({ item }) => {
  await db.feedback.insert(item);
  return { text: `Stored feedback ${item.id}` };
});

// Simple message primitive
tool("send_message", async ({ channel, content }) => {
  await discord.send(channel, content);
  return { text: "Sent" };
});
```

System prompt:
```markdown
## Feedback Processing

When someone shares feedback:
1. Generate a unique ID
2. Rate importance 1-5 based on impact and urgency
3. Store using store_feedback with the full item
4. If importance >= 4, send a notification to the team channel

Importance guidelines:
- 5: Critical (crashes, data loss, security)
- 4: High (detailed bug reports, blocking issues)
- 3: Medium (suggestions, minor bugs)
- 2: Low (cosmetic, edge cases)
- 1: Minimal (off-topic, duplicates)
```

**Example 2: Report Generation**

Before:
```typescript
tool("generate_weekly_report", async ({ startDate, endDate, format }) => {
  const data = await fetchMetrics(startDate, endDate);
  const summary = summarizeMetrics(data);
  const charts = generateCharts(data);

  if (format === "html") {
    return renderHtmlReport(summary, charts);
  } else if (format === "markdown") {
    return renderMarkdownReport(summary, charts);
  } else {
    return renderPdfReport(summary, charts);
  }
});
```

After:
```typescript
tool("query_metrics", async ({ start, end }) => {
  const data = await db.metrics.query({ start, end });
  return { text: JSON.stringify(data, null, 2) };
});

tool("write_file", async ({ path, content }) => {
  writeFileSync(path, content);
  return { text: `Wrote ${path}` };
});
```

System prompt:
```markdown
## Report Generation

When asked to generate a report:
1. Query the relevant metrics using query_metrics
2. Analyze the data and identify key trends
3. Create a clear, well-formatted report
4. Write it using write_file in the appropriate format

Use your judgment about format and structure. Make it useful.
```
</before_after>

<common_challenges>
## Common Refactoring Challenges

**"But the agent might make mistakes!"**

Yes, and you can iterate. Change the prompt to add guidance:
```markdown
// Before
Rate importance 1-5.

// After (if agent keeps rating too high)
Rate importance 1-5. Be conservative—most feedback is 2-3.
Only use 4-5 for truly blocking or critical issues.
```

**"The workflow is complex!"**

Complex workflows can still be expressed in prompts. The agent is smart.
```markdown
When processing video feedback:
1. Check if it's a Loom, YouTube, or direct link
2. For YouTube, pass URL directly to video analysis
3. For others, download first, then analyze
4. Extract timestamped issues
5. Rate based on issue density and severity
```

**"We need deterministic behavior!"**

Some operations should stay in code. That's fine. Prompt-native isn't all-or-nothing.

Keep in code:
- Security validation
- Rate limiting
- Audit logging
- Exact format requirements

Move to prompts:
- Categorization decisions
- Priority judgments
- Content generation
- Workflow orchestration

**"What about testing?"**

Test outcomes, not procedures:
- "Given this input, does the agent achieve the right result?"
- "Does stored feedback have reasonable importance ratings?"
- "Are notifications sent for truly high-priority items?"
</common_challenges>

<checklist>
## Refactoring Checklist

Diagnosis:
- [ ] Listed all tools with business logic
- [ ] Identified artificial limits on agent capability
- [ ] Found prompts that micromanage HOW

Refactoring:
- [ ] Extracted primitives from workflow tools
- [ ] Moved business logic to system prompt
- [ ] Removed artificial limits
- [ ] Simplified tool inputs to data, not decisions

Validation:
- [ ] Agent achieves same outcomes with primitives
- [ ] Behavior can be changed by editing prompts
- [ ] New features could be added without new tools
</checklist>
