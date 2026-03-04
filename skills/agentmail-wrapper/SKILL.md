# AgentMail Wrapper

**Version:** 1.0.0  
**Author:** Midas Skills  
**License:** MIT

## Description

Verified email delivery integration. Send, track, schedule with multi-provider support (SendGrid, Mailgun, AWS SES, SMTP). GDPR/CAN-SPAM compliant.

## Value Proposition

Verified email agent integration. Send, track, schedule emails with verified delivery & unsubscribe compliance. SMTP, API, OAuth support.

## Category

email-integration

## Tags

email, delivery-tracking, multi-provider, compliance, automation

## Skill Type

integration

## Pricing

- **Free:** $0
- **Pro:** $44.99

## Key Features

- ✅ Multi-provider support (SendGrid, Mailgun, AWS SES, SMTP)
- ✅ Delivery tracking (open, click, bounce)
- ✅ Email verification
- ✅ Template management
- ✅ Scheduled sends
- ✅ Batch processing
- ✅ Unsubscribe management
- ✅ List hygiene (bounce handling)
- ✅ Compliance reporting
- ✅ OAuth support (Gmail)
- ✅ Reply tracking

## Use Cases

- Transactional email delivery (signups, resets)
- Email campaign automation
- Scheduled email sequences
- Delivery verification & tracking
- List management (unsubscribes, bounces)
- Multi-account SMTP management
- Email template management
- Compliance reporting

## Installation

```bash
npm install agentmail-wrapper
# or
pip install agentmail-wrapper
```

## Quick Start

```javascript
const AgentMail = require("agentmail-wrapper");

const mail = new AgentMail({
  provider: "sendgrid", // or 'smtp', 'mailgun', 'aws-ses'
  apiKey: process.env.SENDGRID_API_KEY,
});

await mail.send({
  to: "user@example.com",
  subject: "Welcome!",
  html: "<h1>Hello</h1>",
  trackClicks: true,
  trackOpens: true,
});
```

## Repository

https://github.com/midas-skills/agentmail-wrapper

## Support

📧 support@midas-skills.com  
🔗 Docs: https://docs.midas-skills.com/agentmail-wrapper
