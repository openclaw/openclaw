---
name: design-references
description: "Search and capture design references from ThemeForest, Dribbble, and Awwwards. Takes screenshots of website templates for client approval."
homepage: https://themeforest.net
metadata:
  {
    "openclaw":
      {
        "emoji": "🎨",
        "requires": { "config": ["browser.enabled"] },
        "tags": ["design", "references", "screenshots", "templates"],
      },
  }
---

# Design References Skill

Search and capture design references from popular design platforms for client website projects.

## Overview

This skill helps find and capture design inspirations from:
- **ThemeForest** - WordPress/HTML templates
- **Dribbble** - UI/UX designs and mockups
- **Awwwards** - Award-winning websites
- **Behance** - Creative portfolios

## Search Strategies by Business Type

### Restaurant / Food Business

```
ThemeForest: https://themeforest.net/search?term=restaurant&category=wordpress
Dribbble: https://dribbble.com/search/restaurant-website
Awwwards: https://www.awwwards.com/websites/food-drink/
```

### Professional Services (Law, Consulting, etc.)

```
ThemeForest: https://themeforest.net/search?term=corporate&category=wordpress
Dribbble: https://dribbble.com/search/corporate-website
Awwwards: https://www.awwwards.com/websites/business-corporate/
```

### E-commerce / Online Store

```
ThemeForest: https://themeforest.net/search?term=ecommerce&category=wordpress
Dribbble: https://dribbble.com/search/ecommerce-website
Awwwards: https://www.awwwards.com/websites/e-commerce/
```

### Portfolio / Creative

```
ThemeForest: https://themeforest.net/search?term=portfolio&category=wordpress
Dribbble: https://dribbble.com/search/portfolio-website
Awwwards: https://www.awwwards.com/websites/portfolio/
```

### Healthcare / Medical

```
ThemeForest: https://themeforest.net/search?term=medical&category=wordpress
Dribbble: https://dribbble.com/search/healthcare-website
Awwwards: https://www.awwwards.com/websites/health/
```

### Real Estate

```
ThemeForest: https://themeforest.net/search?term=real+estate&category=wordpress
Dribbble: https://dribbble.com/search/real-estate-website
Awwwards: https://www.awwwards.com/websites/real-estate/
```

### Fitness / Gym

```
ThemeForest: https://themeforest.net/search?term=fitness&category=wordpress
Dribbble: https://dribbble.com/search/fitness-website
Awwwards: https://www.awwwards.com/websites/sport/
```

## Workflow

### Step 1: Identify Business Category

Based on client briefing, determine the best search terms:

```javascript
const BUSINESS_CATEGORIES = {
  restaurant: ['restaurant', 'food', 'cafe', 'bar'],
  retail: ['ecommerce', 'shop', 'store', 'boutique'],
  services: ['corporate', 'business', 'consulting', 'agency'],
  health: ['medical', 'healthcare', 'clinic', 'dental'],
  creative: ['portfolio', 'photography', 'design', 'art'],
  tech: ['startup', 'saas', 'technology', 'app'],
  education: ['education', 'school', 'course', 'academy'],
  realestate: ['real estate', 'property', 'realtor'],
  fitness: ['fitness', 'gym', 'yoga', 'sports'],
};

function getSearchTerms(businessType) {
  for (const [category, terms] of Object.entries(BUSINESS_CATEGORIES)) {
    if (terms.some(term => businessType.toLowerCase().includes(term))) {
      return terms;
    }
  }
  return ['business', 'professional'];
}
```

### Step 2: Search and Screenshot

Using OpenClaw browser tools:

```bash
# Navigate to ThemeForest
browser navigate "https://themeforest.net/search?term=restaurant"

# Wait for results to load
browser wait 2000

# Take screenshot of results
browser snapshot --name "themeforest-results.png"

# Click on first result for detail view
browser click "article.product-list__item:first-child a"

# Take screenshot of template preview
browser snapshot --name "template-preview-1.png"
```

### Step 3: Capture Multiple Options

```javascript
async function captureReferences(searchTerm, count = 5) {
  const references = [];

  // Search ThemeForest
  await browser.navigate(`https://themeforest.net/search?term=${encodeURIComponent(searchTerm)}`);
  await browser.wait(2000);

  // Get first N results
  const results = await browser.evaluate(`
    Array.from(document.querySelectorAll('article.product-list__item'))
      .slice(0, ${count})
      .map(el => ({
        title: el.querySelector('h3')?.textContent,
        url: el.querySelector('a')?.href,
        image: el.querySelector('img')?.src,
        price: el.querySelector('.product-list__price')?.textContent,
      }))
  `);

  for (let i = 0; i < results.length; i++) {
    const result = results[i];

    // Navigate to preview
    await browser.navigate(result.url);
    await browser.wait(2000);

    // Take screenshot
    const screenshot = await browser.snapshot();

    references.push({
      index: i + 1,
      title: result.title,
      url: result.url,
      screenshot: screenshot,
      source: 'ThemeForest',
    });
  }

  return references;
}
```

### Step 4: Send to Client

Format references for WhatsApp:

```javascript
async function sendReferencesToClient(phoneNumber, references) {
  // Send intro message
  await sendMessage(phoneNumber, `
Encontrei ${references.length} referências de design para seu projeto! 🎨

Vou enviar cada uma agora. Me diz qual estilo você mais gosta!
  `);

  // Send each reference with screenshot
  for (const ref of references) {
    await sendImage(phoneNumber, ref.screenshot, `
📌 Referência ${ref.index}: ${ref.title}
🔗 Fonte: ${ref.source}
    `);
  }

  // Send follow-up
  await sendMessage(phoneNumber, `
Qual dessas referências você mais gostou?

Pode me dizer:
- O número (1, 2, 3...)
- "Gostei do estilo do 2 mas com as cores do 4"
- Ou descrever o que prefere de cada um
  `);
}
```

## Screenshot Best Practices

### Viewport Settings

```javascript
// Set consistent viewport for screenshots
await browser.setViewport({
  width: 1440,
  height: 900,
  deviceScaleFactor: 2, // Retina quality
});
```

### Full Page vs Viewport

```javascript
// Viewport only (faster, shows above-fold)
await browser.snapshot({ fullPage: false });

// Full page (slower, complete design)
await browser.snapshot({ fullPage: true });
```

### Crop Hero Section

```javascript
// Capture just the hero section
await browser.snapshot({
  clip: {
    x: 0,
    y: 0,
    width: 1440,
    height: 800,
  },
});
```

## Curated Reference Lists

For quick reference without live searching:

### Modern Minimalist Style

1. Stripe - https://stripe.com
2. Linear - https://linear.app
3. Notion - https://notion.so
4. Vercel - https://vercel.com

### Bold & Colorful Style

1. Slack - https://slack.com
2. Spotify - https://spotify.com
3. Airbnb - https://airbnb.com
4. Mailchimp - https://mailchimp.com

### Corporate Professional Style

1. IBM - https://ibm.com
2. Deloitte - https://deloitte.com
3. McKinsey - https://mckinsey.com
4. Accenture - https://accenture.com

### Creative Portfolio Style

1. Awwwards Winners - https://www.awwwards.com/websites/portfolio/
2. Behance Featured - https://www.behance.net/galleries/8/Interaction
3. Dribbble Popular - https://dribbble.com/shots/popular/web-design

## Error Handling

```javascript
async function safeCapture(url) {
  try {
    await browser.navigate(url);
    await browser.wait(3000);

    // Check if page loaded properly
    const title = await browser.evaluate('document.title');
    if (!title || title.includes('Error') || title.includes('404')) {
      return { error: 'Page not found or error' };
    }

    const screenshot = await browser.snapshot();
    return { success: true, screenshot };
  } catch (error) {
    return { error: error.message };
  }
}
```

## Integration Tips

1. **Cache screenshots** - Store captured references to avoid repeated searches
2. **Compress images** - Reduce file size for WhatsApp delivery
3. **Add watermarks** - Mark references with numbers for easy selection
4. **Track preferences** - Remember client's style preferences for future projects
