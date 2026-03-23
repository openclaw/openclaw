---
name: investor-outreach-email
description: Draft and send investor outreach emails that include investor portal access, specific links (thesis/model/deck), and meeting-time options in a requested timezone. Use when the user asks to contact an investor, share the portal, request feedback, propose times, and/or add the recipient to the portal allowlist.
---

# investor-outreach-email

1. Confirm recipient details and constraints.
   - Capture full name + email.
   - Capture whether this is draft-only or send-now.
   - Capture required tone (formal/concise/friendly).

2. Ensure portal access is in place.
   - Prefer adding recipient via the portal allowlist database/admin workflow.
   - Avoid code/deploy changes for one-off recipient adds unless explicitly required.

3. Draft the email with this structure.
   - Brief context line (great connecting / thanks for interest).
   - Use this exact portal-intro phrasing: `Here is our investor portal:` followed by `https://investors.deepmarketmaking.com`.
   - Bullet list of what they can review (at minimum):
     - Investor Thesis: `https://investors.deepmarketmaking.com/thesis.html`
     - Investor Model: `https://investors.deepmarketmaking.com/investor-model.html`
   - Meeting CTA sentence in requested timezone, e.g.:
     - "Happy to go through the full details in 10 minutes. Are you available [time options]?"
   - Include 3 specific time options spread across 3 different days.
   - Prefer different times of day across those options (e.g., morning, midday, afternoon).
   - Add support line: ask them to reach out if they have trouble accessing the portal.

4. Timezone handling.
   - If user requests a timezone (e.g., Mountain Time), present times in that timezone explicitly.
   - Keep times concrete with weekday + date + time + timezone abbreviation.

5. Approval gate.
   - If user says "don’t send without review," always present draft first.
   - Do not send until the user explicitly approves.

6. Send step (after approval only).
   - Use `gog gmail send` with plain-text body (`--body-file`) for reliable formatting.
   - Echo back message ID and recipients after send.

## Draft template

Subject: DeepMM investor portal access + quick walkthrough

Hi {FirstName},

Great connecting. I wanted to share our investor portal:
https://investors.deepmarketmaking.com

You can review:

- Investor Thesis: https://investors.deepmarketmaking.com/thesis.html
- Investor Model: https://investors.deepmarketmaking.com/investor-model.html
- Pitch deck and supporting materials in the portal

Happy to go through the full details in 10 minutes. Are you available {Option 1}, {Option 2}, or {Option 3} ({Timezone})?

If you have any trouble accessing the portal, just reply and I’ll fix it right away.

Best,
Nathan
