# Vibeclaw Campaign Playbook

## Quick Start Checklist

1. Set `VIBECLAW_WORKSPACE` environment variable
2. Create workspace directory with subdirectories:
   ```
   mkdir -p $VIBECLAW_WORKSPACE/{config,logs,drafts,data,learnings}
   mkdir -p $VIBECLAW_WORKSPACE/drafts/{social,youtube,articles}
   ```
3. Create `$VIBECLAW_WORKSPACE/config.json` with product info
4. Configure platform API keys in OpenClaw config
5. Run `openclaw vibeclaw init` to verify setup

## Campaign Templates

### Template 1: Product Launch (Week 1-4)

```
Week 1: Directory submissions (30 directories) + Show HN post
Week 2: Content syndication (10 topics across 20 platforms each)
Week 3: Intent sniping (Reddit + Quora) + X reply agent
Week 4: Community engagement (15 Discord/Telegram groups)
```

### Template 2: SEO Blitz (Week 1-2)

```
Week 1: SEO gap analysis + generate 20 articles
Week 2: Publish + syndicate for backlinks + submit to directories
```

### Template 3: Social Growth (Ongoing)

```
Daily: 2 TikTok carousels + 1 X thread + 100 X replies
Weekly: 1 YouTube long-form + 5 Shorts
Monthly: Review metrics, update skill-learner
```

### Template 4: Lead Generation (Ongoing)

```
Daily: Job board monitoring + 20 outreach emails
Weekly: Intent sniping across Reddit/Quora + community engagement
Monthly: Content for SEO keywords that drive demo requests
```

## Agent Coordination Matrix

| Agent A                | Agent B              | Coordination                                                    |
| ---------------------- | -------------------- | --------------------------------------------------------------- |
| content-syndication    | seo-gap-exploiter    | Gap exploiter identifies keywords → syndication creates content |
| intent-sniper          | skill-learner        | Sniper logs replies → learner identifies best templates         |
| x-reply-agent          | skill-learner        | Reply agent logs engagement → learner updates tone guide        |
| social-content-factory | youtube-automation   | Factory creates Shorts → YouTube publishes them                 |
| directory-submitter    | content-syndication  | Directories provide backlinks → syndication adds more           |
| job-sniper             | community-engagement | Job leads → community validates the pain point                  |

## Metrics Dashboard

Track these KPIs weekly:

| Metric                   | Source             | Target             |
| ------------------------ | ------------------ | ------------------ |
| Website visits/day       | Analytics          | 200+ after month 1 |
| Backlinks gained         | SEO tool           | 100+/month         |
| Social followers         | Platform analytics | +500/month         |
| Replies sent             | Agent logs         | 100-150/day        |
| Content pieces published | Agent logs         | 50+/week           |
| Directory listings       | Submission tracker | 100+ total         |
| Leads generated          | CRM/logs           | 20+/month          |
| Demos booked             | CRM                | 5+/month           |
| Revenue                  | Stripe/analytics   | Grow 20%/month     |
| API spend                | Cost tracker       | <$150/month        |
