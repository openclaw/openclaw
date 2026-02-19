# Marketing Playbooks

## PB-MKT-001: Social Media Launch Sequence

**Trigger:** New business or product launch
**Success Rate:** 72%

### Steps

1. Set up platform accounts (marketing_connect for each platform)
2. Create content calendar for first 30 days (content_calendar add)
3. Publish teaser content — 3 posts across platforms (content_publish)
4. Launch day: coordinated cross-platform push
5. Run engagement campaign — $20-50/day (ad_campaign_create, objective: engagement)
6. Monitor daily analytics (ad_analytics)
7. Week 2: scale winning content, pause underperformers (ad_campaign_manage)
8. Week 4: review and store case (cbr_store)

---

## PB-MKT-002: Meta Ads Scaling Playbook

**Trigger:** Campaign with ROAS > 2x for 3+ days
**Success Rate:** 65%

### Steps

1. Duplicate winning ad set (ad_campaign_manage: duplicate)
2. Increase budget 20% on original (ad_campaign_manage: update_budget)
3. Create lookalike audience from converters (audience_create: lookalike)
4. Test new ad set with lookalike audience
5. Monitor CPA for 48 hours
6. If CPA < target: scale another 20%
7. If CPA > target × 1.5: pause new ad set
8. Weekly: report to CFO on ROAS and spend (agent_message)

---

## PB-MKT-003: Multi-Platform Content Distribution

**Trigger:** New content piece ready
**Success Rate:** 78%

### Adaptation per platform

- **Facebook:** Full post with link, image, CTA
- **Instagram:** Visual-first, carousel or reel, hashtags (up to 30)
- **LinkedIn:** Professional tone, thought leadership angle, no hashtag spam
- **Pinterest:** Vertical image, keyword-rich description, link to content
- **TikTok:** Short video (<60s), trending audio, casual tone
- **WhatsApp:** Business broadcast to engaged segment (template message)

### Steps

1. Adapt content for each platform format
2. Schedule staggered publishing (content_calendar)
3. Publish to all platforms (content_publish)
4. Monitor engagement for 24 hours
5. Boost top performer with $10-20 (ad_campaign_create: engagement)

---

## PB-MKT-004: WhatsApp Business Nurture Sequence

**Trigger:** New lead or customer
**Success Rate:** 81%

### Steps

1. Day 0: Welcome template message (whatsapp_send: template)
2. Day 1: Value-add content (whatsapp_send: image with tip)
3. Day 3: Interactive check-in with buttons (whatsapp_send: interactive)
4. Day 7: Offer/promotion with CTA
5. Day 14: Feedback request
6. Track open rates and responses via ad_analytics

---

## PB-MKT-005: Retargeting Funnel

**Trigger:** Website traffic > 1000 visitors/month
**Success Rate:** 70%

### Steps

1. Create website visitor audience — 30 day (audience_create: website_visitors)
2. Create lookalike from customers (audience_create: lookalike, 1%)
3. Top of funnel: awareness campaign to lookalike ($15/day)
4. Middle: retarget website visitors with social proof ($10/day)
5. Bottom: retarget cart abandoners with offer ($5/day)
6. Monitor ROAS at each level weekly
7. Escalate to CEO if total spend > budget threshold (decision_request)
