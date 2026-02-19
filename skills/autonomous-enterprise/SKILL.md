---
name: autonomous-enterprise
description: "Autonomous enterprise workflows with human-in-the-loop approval gates and safety guards. Build self-managing business operations with payment/data protection."
metadata:
  {
    "openclaw":
      {
        "emoji": "🏢",
        "requires": { "config": { "enterprise.enabled": true } },
      },
  }
---

# Autonomous Enterprise Skill

Build autonomous business workflows with safety guards and human-in-the-loop approval gates. Enable self-managing operations while protecting payments, user data, and preventing destructive actions.

## When to Use

✅ **USE this skill when:**

- Building autonomous business operations
- Creating workflows that need human approval
- Protecting sensitive operations (payments, user data)
- Automating repetitive business tasks
- Building self-managing systems

❌ **DON'T use this skill when:**

- Simple one-off tasks (use regular tools)
- Operations that don't need approval
- Non-business workflows

## Configuration

Enable in `~/.openclaw/openclaw.json`:

```json5
{
  enterprise: {
    enabled: true,
    approvalGates: {
      payments: true,
      userData: true,
      destructive: true,
    },
    safetyGuards: {
      payments: true,
      userData: true,
      destructive: true,
      externalApi: false,
    },
  },
}
```

## Safety Guards

Safety guards automatically block dangerous operations:

- **Payments**: Blocks payment/transaction operations
- **User Data**: Blocks access to user personal information
- **Destructive**: Blocks delete/destroy operations
- **External API**: Blocks external API calls (optional)

## Approval Gates

Approval gates require human approval before proceeding:

- **Payment Operations**: Always require approval
- **User Data Access**: Always require approval
- **Custom Gates**: Define custom approval points

## Workflow Types

### Task Step

Execute a task/action:

```typescript
{
  id: "fetch_news",
  name: "Fetch Latest News",
  type: "task",
  action: "news_aggregate",
  onSuccess: "rank_articles",
}
```

### Approval Step

Require human approval:

```typescript
{
  id: "approve_payment",
  name: "Approve Payment",
  type: "approval",
  approvalGate: "payments",
  onSuccess: "process_payment",
  onFailure: "cancel_payment",
}
```

### Condition Step

Branch based on condition:

```typescript
{
  id: "check_threshold",
  name: "Check Threshold",
  type: "condition",
  condition: "articles.length > 10",
  onSuccess: "send_newsletter",
  onFailure: "wait_more",
}
```

### Parallel Step

Execute multiple steps in parallel:

```typescript
{
  id: "parallel_analysis",
  name: "Parallel Analysis",
  type: "parallel",
  parallelSteps: ["analyze_claude", "analyze_gpt", "analyze_gemini"],
  onSuccess: "synthesize_results",
}
```

## Usage Examples

### Define Workflow

```typescript
const workflow = {
  id: "daily_news_workflow",
  name: "Daily News Aggregation",
  enabled: true,
  steps: [
    {
      id: "fetch",
      name: "Fetch News",
      type: "task",
      action: "news_aggregate",
      onSuccess: "rank",
    },
    {
      id: "rank",
      name: "Rank Articles",
      type: "task",
      action: "content_rank",
      onSuccess: "approve",
    },
    {
      id: "approve",
      name: "Approve Newsletter",
      type: "approval",
      approvalGate: "newsletter",
      requiresApproval: true,
      onSuccess: "send",
    },
    {
      id: "send",
      name: "Send Newsletter",
      type: "task",
      action: "send_newsletter",
    },
  ],
};

enterprise_workflow({ action: "register", workflow });
```

### Start Workflow

```typescript
const execution = await enterprise_workflow({
  action: "start",
  workflowId: "daily_news_workflow",
});
```

### Approve Request

```typescript
await enterprise_approve({
  requestId: "approval_123",
  approvedBy: "user@example.com",
});
```

### Check Status

```typescript
const status = await enterprise_status({
  executionId: "exec_456",
});
```

## Best Practices

1. **Safety First**: Always enable safety guards for sensitive operations
2. **Approval Gates**: Use approval gates for critical decisions
3. **Error Handling**: Define `onFailure` paths for all steps
4. **Monitoring**: Regularly check workflow execution status
5. **Testing**: Test workflows in a safe environment first

## Security Considerations

- Payment operations always require approval
- User data access is blocked by default
- Destructive operations require explicit approval
- All operations are logged for audit trail
- Approval requests expire after timeout

## Limitations

- Workflows are sequential by default (use parallel for concurrency)
- Approval polling has inherent delay (use events for real-time)
- Safety guards are keyword-based (may have false positives)

## See Also

- News aggregator skill
- Content ranking skill
- Society of Minds skill
- Workflow documentation
