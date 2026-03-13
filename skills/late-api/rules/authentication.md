# Authentication

## API Key Format

```
sk_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6
```

- Prefix: `sk_`
- Length: 67 characters
- Get yours at: [getlate.dev/dashboard/api-keys](https://getlate.dev/dashboard/api-keys)

## Usage Examples

### curl

```bash
curl https://getlate.dev/api/v1/profiles \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### TypeScript

```typescript
const response = await fetch("https://getlate.dev/api/v1/profiles", {
  headers: {
    Authorization: `Bearer ${process.env.LATE_API_KEY}`,
  },
});
```

### Python

```python
import requests

response = requests.get(
    'https://getlate.dev/api/v1/profiles',
    headers={'Authorization': f'Bearer {api_key}'}
)
```

## Core Concepts

```
Profile (brand/project)
  └── Account (connected social account)
        └── Post (content to publish)
```

- **Profile** - Container that groups social accounts (think "brand" or "project")
- **Account** - Connected social media account (Twitter, Instagram, etc.)
- **Post** - Content to publish, can target multiple accounts at once
