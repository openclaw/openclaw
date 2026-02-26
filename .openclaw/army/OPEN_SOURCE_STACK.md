# Open Source Stack for OpenClaw Media Ops

## Target

- Platform first: Xiaohongshu (single-platform SOP)
- Workflow: research -> content -> review -> publish -> retention -> analytics

## Recommended stack (pragmatic)

1. Publishing Hub: Postiz (open-source social scheduler)

- GitHub: https://github.com/gitroomhq/postiz-app
- Role: centralized publishing calendar and channel management
- Use: OpenClaw -> review-approved content -> Postiz API/queue (or operator-assisted push)

2. Workflow Orchestrator: n8n / Activepieces

- n8n: https://github.com/n8n-io/n8n
- Activepieces: https://github.com/activepieces/activepieces
- Role: cross-system triggers, retries, approval flows, alerts
- Use: run approval and delivery automations around OpenClaw jobs

3. Marketing Automation/CRM: Mautic

- Site: https://mautic.org/
- Role: lead nurturing, segmentation, email/CRM automation
- Use: convert inquiry leads from content channels into lifecycle journeys

4. LLM App Layer (optional): Dify / Flowise

- Dify: https://github.com/langgenius/dify
- Flowise: https://github.com/FlowiseAI/Flowise
- Role: visual prompt/app management and quick experiments
- Use: fast iteration for campaign-specific assistants

5. Analytics: PostHog / Matomo / Umami

- PostHog: https://github.com/PostHog/posthog
- Matomo: https://github.com/matomo-org/matomo
- Umami: https://github.com/umami-software/umami
- Role: funnel tracking and attribution
- Use: tie content actions to inquiries and conversion proxies

6. Xiaohongshu-specific helper options (community)

- Autoxhs: https://github.com/Gikiman/Autoxhs
- Xiaohongshu MCP reference page: https://jimmysong.io/ai/xiaohongshu-mcp/
- Note: community tools may break with platform changes; keep canary + manual fallback.

## Integration policy

- Tool-first: prefer mature OSS tool over custom code.
- Build only on gap: if no stable tool path, create custom script/hook/MCP adapter.
- Always keep manual fallback path for publishing.

## Suggested implementation order (for this workspace)

1. Keep current OpenClaw XHS SOP as source-of-truth.
2. Add Postiz as publishing destination.
3. Add n8n or Activepieces for approval routing and failure recovery.
4. Add Mautic for lead nurturing.
5. Add analytics instrumentation for weekly optimization.
