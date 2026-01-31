# OpenClaw Hosted Platform

A hosted/managed version of OpenClaw where users can sign up, get an instant AI assistant instance, and connect their messaging platforms without any technical setup.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Web App (Next.js)                        │
│   - Landing page, Google OAuth, Dashboard, Channel setup UI     │
│   - Hosted on Vercel                                            │
└─────────────────────────────────────────────────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
           ┌────────▼────────┐      ┌─────────▼─────────┐
           │  Supabase       │      │  Control Plane    │
           │  - Auth (Google)│      │  - Instance mgmt  │
           │  - PostgreSQL   │      │  - Channel proxy  │
           │  - Row Security │      │  - Health checks  │
           └─────────────────┘      └─────────┬─────────┘
                                              │
           ┌──────────────────────────────────┴──────────────────┐
           │               DigitalOcean App Platform              │
           │  ┌──────────┐ ┌──────────┐ ┌──────────┐             │
           │  │ User A   │ │ User B   │ │ User C   │  ...        │
           │  │ OpenClaw │ │ OpenClaw │ │ OpenClaw │             │
           │  │ Container│ │ Container│ │ Container│             │
           │  └──────────┘ └──────────┘ └──────────┘             │
           └──────────────────────────────────────────────────────┘
```

## Project Structure

```
hosted/
├── apps/
│   └── web/                        # Next.js web app
│       ├── src/
│       │   ├── app/                # App Router pages
│       │   │   ├── login/          # Login page
│       │   │   ├── dashboard/      # Dashboard pages
│       │   │   └── api/            # API routes
│       │   ├── components/         # React components
│       │   └── lib/                # Utilities
│       │       └── supabase/       # Supabase client
│       └── package.json
├── infrastructure/
│   └── terraform/                  # DigitalOcean infrastructure
│       ├── main.tf                 # Provider config
│       ├── registry.tf             # Container registry
│       └── spaces.tf               # Object storage
└── supabase/
    └── migrations/                 # Database migrations
```

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm
- DigitalOcean account
- Supabase account

### Setup

1. **Install dependencies**
   ```bash
   cd hosted/apps/web
   pnpm install
   ```

2. **Set up Supabase**
   - Create a new Supabase project
   - Run the migration in `supabase/migrations/001_initial_schema.sql`
   - Enable Google OAuth in Authentication settings
   - Copy the project URL and anon key

3. **Configure environment variables**
   ```bash
   cp .env.example .env.local
   # Edit .env.local with your Supabase credentials
   ```

4. **Set up DigitalOcean infrastructure**
   ```bash
   cd infrastructure/terraform
   cp terraform.tfvars.example terraform.tfvars
   # Edit terraform.tfvars with your DO API token
   terraform init
   terraform apply
   ```

5. **Run the development server**
   ```bash
   cd apps/web
   pnpm dev
   ```

## Technology Stack

| Component | Technology |
|-----------|------------|
| Web Framework | Next.js 14 (App Router) |
| Auth | Supabase Auth (Google OAuth) |
| Database | Supabase (PostgreSQL) |
| Container Platform | DigitalOcean App Platform |
| Persistent Storage | DigitalOcean Spaces |
| IaC | Terraform |
| Styling | Tailwind CSS |

## MVP Features

- [x] Google OAuth login
- [ ] One OpenClaw instance per user
- [ ] WhatsApp linking (QR code)
- [ ] Telegram bot token configuration
- [ ] Basic dashboard
- [ ] Health monitoring
