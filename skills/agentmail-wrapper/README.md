# AgentMail Wrapper

**Value Proposition**: Verified email agent integration. Send, track, schedule emails with verified delivery & unsubscribe compliance. SMTP, API, OAuth support.

## Problem Solved

- Email delivery tracking unreliable
- Unsubscribe management complex
- Bulk email sending limits
- SMTP authentication headaches
- Email bounces & list hygiene
- Compliance with CAN-SPAM/GDPR

## Use Cases

- Transactional email delivery (signups, resets)
- Email campaign automation
- Scheduled email sequences
- Delivery verification & tracking
- List management (unsubscribes, bounces)
- Multi-account SMTP management
- Email template management
- Compliance reporting

## Quick Start

```bash
npm install agentmail-wrapper
# or
python -m pip install agentmail-wrapper
```

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

## Features

✅ Multi-provider support (SendGrid, Mailgun, AWS SES, SMTP)
✅ Delivery tracking (open, click, bounce)
✅ Email verification
✅ Template management
✅ Scheduled sends
✅ Batch processing
✅ Unsubscribe management
✅ List hygiene (bounce handling)
✅ Compliance reporting
✅ OAuth support (Gmail)
✅ Reply tracking

## Installation

### Node.js

```bash
npm install agentmail-wrapper
```

### Python

```bash
pip install agentmail-wrapper
```

### Configuration

```javascript
const mail = new AgentMail({
  provider: "sendgrid", // sendgrid, mailgun, aws-ses, smtp, gmail
  apiKey: "sg-...",
  from: "noreply@example.com",
  fromName: "My App",
  trackingDomain: "email.example.com",
  webhookUrl: "https://api.example.com/webhooks/mail",
});
```

## Example Code

### Basic Send with Tracking

```javascript
const mail = new AgentMail();

const result = await mail.send({
  to: "user@example.com",
  subject: "Urgent: Action required",
  html: "<h2>Click here to confirm</h2>",
  trackClicks: true,
  trackOpens: true,
  unsubscribeUrl: "https://example.com/unsub?token=abc123",
});

console.log("Message ID:", result.messageId);
console.log("Tracking ID:", result.trackingId);
```

### Scheduled Email Sequence

```javascript
const sequence = [
  {
    delay: "0m", // immediate
    subject: "Welcome to our platform",
    html: "<h1>Getting started guide</h1>",
  },
  {
    delay: "1h",
    subject: "Set up your profile",
    html: "<h1>Complete your profile</h1>",
  },
  {
    delay: "24h",
    subject: "Your first project awaits",
    html: "<h1>Create your first project</h1>",
  },
];

await mail.sendSequence({
  to: "newuser@example.com",
  sequence: sequence,
  unsubscribeUrl: "https://example.com/unsub",
});
```

### Batch Sending

```javascript
const recipients = [
  { email: "user1@example.com", name: "Alice", customData: { plan: "pro" } },
  { email: "user2@example.com", name: "Bob", customData: { plan: "free" } },
  { email: "user3@example.com", name: "Carol", customData: { plan: "enterprise" } },
];

const results = await mail.sendBatch({
  recipients: recipients,
  subject: "Special offer for {{name}}",
  template: "promotional",
  personalizeVars: {
    name: "{{name}}",
    customOffer: '{{customData.plan === "pro" ? "20% off" : "10% off"}}',
  },
  trackingEnabled: true,
  rateLimit: 5, // 5 emails/second
});

console.log(`Sent: ${results.succeeded}/${results.total}`);
```

### Delivery Tracking

```javascript
const mail = new AgentMail({
  webhookUrl: "https://api.example.com/webhooks/mail",
});

// Webhook handler receives:
// - delivery: email successfully sent
// - bounce: hard bounce (invalid email)
// - open: user opened email
// - click: user clicked link
// - unsubscribe: user clicked unsubscribe

// Query delivery status
const status = await mail.getDeliveryStatus("tracking-id-xyz");
console.log(status);
// {
//   sent: true,
//   delivered: true,
//   opened: true,
//   clicks: [
//     { url: 'https://...', timestamp: 1234567890 }
//   ],
//   bounced: false
// }
```

### List Management & Hygiene

```javascript
const mail = new AgentMail();

// Check if email is valid
const isValid = await mail.verifyEmail("user@example.com");

// Get bounce list
const bounces = await mail.getBounces();
console.log(`${bounces.length} addresses bounced`);

// Remove bounced addresses from list
await mail.removeBouncedAddresses(bounces.map((b) => b.email));

// Export unsubscribes
const unsubscribes = await mail.getUnsubscribes({ since: "2024-01-01" });
```

### Template Management

```javascript
// Create template
const template = await mail.createTemplate({
  name: "Welcome Email",
  subject: "Welcome {{name}}!",
  html: `<h1>Hello {{name}}</h1>
         <p>Your account is ready at {{dashboardUrl}}</p>`,
});

// Use template
await mail.send({
  to: "user@example.com",
  template: template.id,
  variables: {
    name: "John",
    dashboardUrl: "https://app.example.com/dashboard",
  },
});
```

### Gmail OAuth (Auto Reply)

```javascript
const mail = new AgentMail({
  provider: "gmail",
  refreshToken: "refresh-token-from-oauth",
});

await mail.send({
  to: "user@example.com",
  subject: "Auto-reply test",
  html: "This is sent via Gmail",
  from: "your-gmail@gmail.com",
});
```

## API Reference

### `send(options)`

Send single email.

- `to` (string): Recipient
- `subject` (string): Email subject
- `html` (string): Email body (HTML)
- `trackClicks` (boolean): Track link clicks
- `trackOpens` (boolean): Track opens
- Returns: `Promise<{messageId, trackingId}>`

### `sendBatch(options)`

Send multiple emails.

- `recipients` (array): Array of {email, name, ...}
- `subject` (string): Email subject
- `template` (string): Template ID
- `rateLimit` (number): Emails per second
- Returns: `Promise<{succeeded, failed, total}>`

### `getDeliveryStatus(trackingId)`

Get email delivery status.

- Returns: `Promise<{sent, delivered, opened, clicks, bounced}>`

### `verifyEmail(email)`

Check if email is valid/deliverable.

- Returns: `Promise<boolean>`

## Compliance Features

✅ CAN-SPAM compliant (unsubscribe link, physical address)
✅ GDPR compliant (opt-in tracking)
✅ List hygiene (bounce/complaint handling)
✅ Authentication (SPF, DKIM, DMARC support)

## Troubleshooting

**"Authentication failed"?**
→ Check API key is correct for your provider

**Emails landing in spam?**
→ Set up SPF/DKIM records and use tracking domain

**Too many bounces?**
→ Verify email list with `verifyEmail()` before sending

## Support

📧 support@midas-skills.com
🔗 Docs: https://docs.midas-skills.com/agentmail-wrapper

---

**Want pro version + updates?** [Buy bundle on Gumroad](https://gumroad.com/midas-skills)
