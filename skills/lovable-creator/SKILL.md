---
name: lovable-creator
description: "Create websites using Lovable.dev API. Generates app creation URLs from prompts and images, monitors creation progress, and retrieves preview URLs."
homepage: https://lovable.dev
metadata:
  {
    "openclaw":
      {
        "emoji": "💜",
        "requires": { "env": ["LOVABLE_API_KEY"], "config": ["browser.enabled"] },
        "tags": ["website", "app-builder", "lovable"],
      },
  }
---

# Lovable Creator Skill

Create websites and apps using an AI-powered platform.

## CRITICAL RULE - WHITE LABEL

**NEVER mention the platform name (Lovable) to the client.**
- This skill is internal-only
- Never share lovable.dev URLs with clients
- Never share *.lovable.app preview URLs with clients
- Always use the deploy-handler skill to set up custom domains before delivery

## Overview

Lovable is an AI platform that creates full-stack web applications from natural language prompts. This skill enables programmatic website creation through Lovable's Build with URL API.

## API Reference

### Build with URL

Base URL: `https://lovable.dev/?autosubmit=true#`

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| prompt | string | Yes | Description of the app to build (max 50,000 chars) |
| images | string[] | No | Up to 10 public image URLs for reference |

### URL Format

```
https://lovable.dev/?autosubmit=true#prompt={URL_ENCODED_PROMPT}&images={IMAGE_URL_1}&images={IMAGE_URL_2}
```

### Example URLs

Simple app:
```
https://lovable.dev/?autosubmit=true#prompt=Create%20a%20modern%20portfolio%20website%20for%20a%20photographer
```

With reference images:
```
https://lovable.dev/?autosubmit=true#prompt=Create%20a%20landing%20page%20like%20this%20design&images=https://example.com/reference.jpg
```

## Workflow

### Step 1: Generate Creation URL

Given a client briefing, construct a detailed prompt:

```javascript
function generateLovableUrl(briefing) {
  const prompt = `
Create a ${briefing.type} website for a ${briefing.businessType} business.

Target audience: ${briefing.targetAudience}
Main objective: ${briefing.objective}
Color scheme: ${briefing.colors}

Required features:
${briefing.features.map(f => `- ${f}`).join('\n')}

Style: ${briefing.style || 'Modern and professional'}

The website should be responsive and mobile-friendly.
  `.trim();

  const encodedPrompt = encodeURIComponent(prompt);
  let url = `https://lovable.dev/?autosubmit=true#prompt=${encodedPrompt}`;

  if (briefing.referenceImages?.length) {
    briefing.referenceImages.forEach(img => {
      url += `&images=${encodeURIComponent(img)}`;
    });
  }

  return url;
}
```

### Step 2: Open Creation URL

Use browser tool to navigate to the creation URL:

```bash
# Using OpenClaw browser tool
browser navigate "https://lovable.dev/?autosubmit=true#prompt=..."
```

### Step 3: Monitor Progress

1. Wait for Lovable workspace selection (if authenticated)
2. Wait for app generation to complete
3. Capture the preview URL from the browser

```bash
# Take screenshot of progress
browser snapshot

# Get current URL (should contain project ID after creation)
browser url
```

### Step 4: Get Preview URL

After creation completes, the URL will be:
```
https://lovable.dev/projects/{PROJECT_ID}
```

The live preview URL format:
```
https://{PROJECT_ID}.lovable.app
```

## Prompt Engineering Tips

For best results, include in your prompts:

1. **Business context**: Type of business, industry
2. **Visual style**: Modern, minimal, bold, corporate, etc.
3. **Color scheme**: Specific colors or let AI choose
4. **Layout preferences**: Single page, multi-page, sections
5. **Features**: Contact form, gallery, testimonials, etc.
6. **Content hints**: Placeholder text preferences, imagery style

### Example Detailed Prompt

```
Create a professional website for a Brazilian coffee shop called "Café do Brasil".

Style: Warm, inviting, modern with rustic touches
Colors: Coffee browns (#4A3728), cream (#F5F1EB), accent gold (#C4A962)
Target audience: Coffee enthusiasts aged 25-45

Sections:
1. Hero with large image and tagline "O melhor café do Brasil"
2. About section with story of the coffee shop
3. Menu section with categories (espresso, cold brew, pastries)
4. Gallery with coffee preparation images
5. Location and hours with embedded map placeholder
6. Contact form for reservations

Features:
- Responsive mobile design
- Smooth scroll navigation
- WhatsApp contact button (floating)
- Portuguese language content

Make it feel authentic and premium.
```

## Limitations

- **No REST API**: Currently URL-based only, requires browser automation
- **Authentication required**: Must be logged into Lovable account
- **Manual workspace selection**: May require user interaction
- **URL length limits**: Very long prompts may fail

## Alternative: Direct Browser Automation

For fully automated creation, use Playwright/browser tools:

```javascript
// Pseudocode for automated creation
async function createSiteAutomated(prompt) {
  // 1. Navigate to Lovable
  await browser.goto('https://lovable.dev');

  // 2. Login if needed
  if (await browser.isVisible('button:has-text("Sign in")')) {
    // Handle authentication
  }

  // 3. Navigate to creation URL
  const url = generateLovableUrl({ prompt });
  await browser.goto(url);

  // 4. Wait for creation to complete
  await browser.waitForSelector('[data-testid="preview-ready"]', { timeout: 300000 });

  // 5. Get preview URL
  const previewUrl = await browser.evaluate(() => window.location.href);
  return previewUrl;
}
```

## Future API Features (Expected)

Lovable has indicated plans to expand their API with:
- REST endpoints for project management
- Webhook notifications for build completion
- API keys for authentication
- Project editing endpoints

Monitor https://docs.lovable.dev/integrations/lovable-api for updates.
