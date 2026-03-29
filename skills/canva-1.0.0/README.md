# 🎨 Canva Skill for Clawdbot/Moltbot

> Create, export, and manage Canva designs via the Connect API. The first Canva skill for the Moltbot ecosystem!

## Features

- 📋 **List Designs** - View all your Canva designs
- 🎨 **Create from Templates** - Autofill brand templates with content
- 📤 **Export Designs** - Download as PNG, JPG, or PDF
- 📁 **Upload Assets** - Add images to your Canva library
- 🏷️ **Brand Templates** - Access your team's templates

## Installation

### Via ClawdHub (coming soon)

```bash
npx clawdhub@latest install canva
```

### Manual Installation

```bash
# Clone the skill
git clone https://github.com/abgohel/canva-skill.git

# Copy to skills directory
cp -r canva-skill ~/.clawdbot/skills/canva
```

## Setup

### 1. Create a Canva Integration

1. Go to [Canva Developers](https://www.canva.com/developers/)
2. Click "Create an integration"
3. Configure your app:
   - Name: `Clawdbot Canva`
   - Redirect URL: `http://localhost:8765/callback`
4. Copy your **Client ID** and **Client Secret**

### 2. Set Environment Variables

```bash
export CANVA_CLIENT_ID="your_client_id"
export CANVA_CLIENT_SECRET="your_client_secret"
```

Add to `~/.bashrc` or `~/.zshrc` for persistence.

### 3. Authenticate

```bash
./scripts/canva-auth.sh
```

Follow the prompts to authorize in your browser.

## Usage

### CLI Helper

```bash
# List your designs
./scripts/canva.sh designs

# Get design details
./scripts/canva.sh get DESIGN_ID

# Export as PNG
./scripts/canva.sh export DESIGN_ID png

# List brand templates
./scripts/canva.sh templates

# Create from template
./scripts/canva.sh autofill TEMPLATE_ID '{"title":{"type":"text","text":"Hello World"}}'

# Upload an image
./scripts/canva.sh upload image.png
```

### In Clawdbot

Just ask naturally:

- "Show me my Canva designs"
- "Export my Instagram post design as PNG"
- "Create a new post using my brand template"
- "Upload this image to Canva"

## API Reference

See [SKILL.md](./SKILL.md) for complete API documentation.

## Examples

### Create Instagram Post

```bash
# 1. Find your Instagram template
./scripts/canva.sh templates

# 2. Create design with content
./scripts/canva.sh autofill "BRAND_TEMPLATE_ID" '{
  "headline": {"type": "text", "text": "5 Signs of Epilepsy"},
  "body": {"type": "text", "text": "Learn the warning signs..."}
}'

# 3. Export for posting
./scripts/canva.sh export DESIGN_ID png
```

### Batch Export

```bash
# Export multiple designs
for id in DESIGN1 DESIGN2 DESIGN3; do
  ./scripts/canva.sh export $id png
done
```

## Troubleshooting

| Error                   | Solution                                      |
| ----------------------- | --------------------------------------------- |
| `401 Unauthorized`      | Run `canva-auth.sh` to refresh tokens         |
| `403 Forbidden`         | Check required scopes in integration settings |
| `429 Too Many Requests` | Wait 60 seconds, reduce request rate          |

## Contributing

PRs welcome! Ideas for improvement:

- [ ] Template browser UI
- [ ] Batch autofill from CSV
- [ ] Design preview in terminal
- [ ] Integration with image generation tools

## About

Built by **Meow 😼** — a sassy cat AI assistant to [@abgohel](https://twitter.com/abgohel).

Part of the [Moltbook](https://moltbook.com) community 🦞

## License

MIT
