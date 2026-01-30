---
name: templates
description: Template listing and variable replacement for HeyGen videos
metadata:
  tags: templates, variables, personalization, batch
---

# Video Templates

HeyGen templates allow you to create reusable video structures with variable placeholders, enabling personalized video generation at scale.

## Listing Templates

### curl

```bash
curl -X GET "https://api.heygen.com/v2/templates" \
  -H "X-Api-Key: $HEYGEN_API_KEY"
```

### TypeScript

```typescript
interface Template {
  template_id: string;
  name: string;
  thumbnail_url: string;
  variables: TemplateVariable[];
}

interface TemplateVariable {
  name: string;
  type: "text" | "image" | "audio";
  properties?: {
    max_length?: number;
    default_value?: string;
  };
}

interface TemplatesResponse {
  error: null | string;
  data: {
    templates: Template[];
  };
}

async function listTemplates(): Promise<Template[]> {
  const response = await fetch("https://api.heygen.com/v2/templates", {
    headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! },
  });

  const json: TemplatesResponse = await response.json();

  if (json.error) {
    throw new Error(json.error);
  }

  return json.data.templates;
}
```

### Python

```python
import requests
import os

def list_templates() -> list:
    response = requests.get(
        "https://api.heygen.com/v2/templates",
        headers={"X-Api-Key": os.environ["HEYGEN_API_KEY"]}
    )

    data = response.json()
    if data.get("error"):
        raise Exception(data["error"])

    return data["data"]["templates"]
```

## Response Format

```json
{
  "error": null,
  "data": {
    "templates": [
      {
        "template_id": "template_abc123",
        "name": "Product Announcement",
        "thumbnail_url": "https://files.heygen.ai/...",
        "variables": [
          {
            "name": "product_name",
            "type": "text",
            "properties": {
              "max_length": 50
            }
          },
          {
            "name": "presenter_script",
            "type": "text",
            "properties": {
              "max_length": 500
            }
          },
          {
            "name": "product_image",
            "type": "image"
          }
        ]
      }
    ]
  }
}
```

## Getting Template Details

### curl

```bash
curl -X GET "https://api.heygen.com/v2/template/{template_id}" \
  -H "X-Api-Key: $HEYGEN_API_KEY"
```

### TypeScript

```typescript
async function getTemplate(templateId: string): Promise<Template> {
  const response = await fetch(
    `https://api.heygen.com/v2/template/${templateId}`,
    { headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! } }
  );

  const json = await response.json();

  if (json.error) {
    throw new Error(json.error);
  }

  return json.data;
}
```

## Generating Video from Template

### Request Fields

| Field | Type | Req | Description |
|-------|------|:---:|-------------|
| `variables` | object | ✓ | Key-value pairs matching template variables |
| `test` | boolean | | Test mode (watermarked, no credits) |
| `title` | string | | Video name for organization |
| `callback_id` | string | | Custom ID for webhook tracking |
| `callback_url` | string | | URL for completion notification |

**Note:** The `variables` object keys must match the template's defined variable names. Check template details to see which variables are defined.

### curl

```bash
curl -X POST "https://api.heygen.com/v2/template/{template_id}/generate" \
  -H "X-Api-Key: $HEYGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "test": false,
    "variables": {
      "product_name": "SuperWidget Pro",
      "presenter_script": "Introducing our latest innovation!",
      "product_image": "https://example.com/product.jpg"
    }
  }'
```

### TypeScript

```typescript
interface TemplateGenerateRequest {
  variables: Record<string, string>;           // Required
  test?: boolean;
  title?: string;
  callback_id?: string;
  callback_url?: string;
}

interface TemplateGenerateResponse {
  error: null | string;
  data: {
    video_id: string;
  };
}

async function generateFromTemplate(
  templateId: string,
  variables: Record<string, string>,
  test: boolean = false
): Promise<string> {
  const response = await fetch(
    `https://api.heygen.com/v2/template/${templateId}/generate`,
    {
      method: "POST",
      headers: {
        "X-Api-Key": process.env.HEYGEN_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ test, variables }),
    }
  );

  const json: TemplateGenerateResponse = await response.json();

  if (json.error) {
    throw new Error(json.error);
  }

  return json.data.video_id;
}
```

### Python

```python
def generate_from_template(template_id: str, variables: dict, test: bool = False) -> str:
    response = requests.post(
        f"https://api.heygen.com/v2/template/{template_id}/generate",
        headers={
            "X-Api-Key": os.environ["HEYGEN_API_KEY"],
            "Content-Type": "application/json"
        },
        json={
            "test": test,
            "variables": variables
        }
    )

    data = response.json()
    if data.get("error"):
        raise Exception(data["error"])

    return data["data"]["video_id"]
```

## Variable Types

### Text Variables

For dynamic text content:

```typescript
const variables = {
  customer_name: "John Smith",
  product_name: "SuperWidget Pro",
  price: "$99.99",
  cta_text: "Order Now!",
};
```

### Image Variables

For dynamic images (backgrounds, product shots):

```typescript
const variables = {
  product_image: "https://example.com/product.jpg",
  logo: "https://example.com/logo.png",
  background: "https://example.com/bg.jpg",
};
```

### Audio Variables

For custom audio content:

```typescript
const variables = {
  background_music: "https://example.com/music.mp3",
  custom_voiceover: "https://example.com/voiceover.mp3",
};
```

## Batch Video Generation

Generate multiple personalized videos from a template:

```typescript
interface PersonalizationData {
  name: string;
  email: string;
  company: string;
  customMessage: string;
}

async function batchGenerateVideos(
  templateId: string,
  recipients: PersonalizationData[]
): Promise<string[]> {
  const videoIds: string[] = [];

  for (const recipient of recipients) {
    const variables = {
      recipient_name: recipient.name,
      company_name: recipient.company,
      personalized_message: recipient.customMessage,
    };

    const videoId = await generateFromTemplate(templateId, variables);
    videoIds.push(videoId);

    // Rate limiting: add delay between requests
    await new Promise((r) => setTimeout(r, 1000));
  }

  return videoIds;
}

// Usage
const recipients = [
  {
    name: "John Smith",
    email: "john@example.com",
    company: "Acme Inc",
    customMessage: "Thanks for your interest in our product!",
  },
  {
    name: "Jane Doe",
    email: "jane@example.com",
    company: "Tech Corp",
    customMessage: "We'd love to show you a demo!",
  },
];

const videoIds = await batchGenerateVideos("template_abc123", recipients);
```

## Template Validation

Validate variables before generating:

```typescript
function validateTemplateVariables(
  template: Template,
  variables: Record<string, string>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const templateVar of template.variables) {
    const value = variables[templateVar.name];

    // Check if required variable is provided
    if (!value) {
      errors.push(`Missing required variable: ${templateVar.name}`);
      continue;
    }

    // Check text length limits
    if (templateVar.type === "text" && templateVar.properties?.max_length) {
      if (value.length > templateVar.properties.max_length) {
        errors.push(
          `Variable "${templateVar.name}" exceeds max length of ${templateVar.properties.max_length}`
        );
      }
    }

    // Validate image URLs
    if (templateVar.type === "image") {
      try {
        new URL(value);
      } catch {
        errors.push(`Variable "${templateVar.name}" is not a valid URL`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
```

## Complete Template Workflow

```typescript
async function createPersonalizedVideo(
  templateId: string,
  personalization: Record<string, string>
): Promise<string> {
  // 1. Get template details
  const template = await getTemplate(templateId);
  console.log(`Using template: ${template.name}`);

  // 2. Validate variables
  const validation = validateTemplateVariables(template, personalization);
  if (!validation.valid) {
    throw new Error(`Validation errors: ${validation.errors.join(", ")}`);
  }

  // 3. Generate video
  console.log("Generating video...");
  const videoId = await generateFromTemplate(templateId, personalization);
  console.log(`Video ID: ${videoId}`);

  // 4. Wait for completion
  const videoUrl = await waitForVideo(videoId);
  console.log(`Video ready: ${videoUrl}`);

  return videoUrl;
}

// Usage
const videoUrl = await createPersonalizedVideo("template_abc123", {
  customer_name: "John Smith",
  product_name: "SuperWidget Pro",
  offer_details: "Get 20% off your first order!",
});
```

## Best Practices

1. **Design for flexibility** - Create templates with generic placeholders
2. **Set reasonable limits** - Define max lengths for text variables
3. **Validate inputs** - Check variable values before generating
4. **Use test mode** - Test with `test: true` to verify before production
5. **Implement rate limiting** - Add delays for batch generation
6. **Cache template data** - Reduce API calls by caching template details
7. **Error handling** - Gracefully handle generation failures

## Use Cases

- **Sales outreach** - Personalized prospect videos
- **Customer onboarding** - Welcome videos with customer name
- **Product updates** - Announcements with dynamic content
- **Training** - Customized training modules
- **Marketing campaigns** - Targeted promotional videos
