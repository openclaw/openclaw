# Project Scaffolding

> Directory structure and core files for new projects.

---

## Next.js Full-Stack Structure (2025 Optimized)

```
project-name/
├── src/
│   ├── app/                        # Routes only (thin layer)
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   ├── globals.css
│   │   ├── (auth)/                 # Route group - auth pages
│   │   │   ├── login/page.tsx
│   │   │   └── register/page.tsx
│   │   ├── (dashboard)/            # Route group - dashboard layout
│   │   │   ├── layout.tsx
│   │   │   └── page.tsx
│   │   └── api/
│   │       └── [resource]/route.ts
│   │
│   ├── features/                   # Feature-based modules
│   │   ├── auth/
│   │   │   ├── components/
│   │   │   ├── hooks/
│   │   │   ├── actions.ts          # Server Actions
│   │   │   ├── queries.ts          # Data fetching
│   │   │   └── types.ts
│   │   ├── products/
│   │   │   ├── components/
│   │   │   ├── actions.ts
│   │   │   └── queries.ts
│   │   └── cart/
│   │       └── ...
│   │
│   ├── shared/                     # Shared utilities
│   │   ├── components/ui/          # Reusable UI components
│   │   ├── lib/                    # Utils, helpers
│   │   └── hooks/                  # Global hooks
│   │
│   └── server/                     # Server-only code
│       ├── db/                     # Database client (Prisma)
│       ├── auth/                   # Auth config
│       └── services/               # External API integrations
│
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
│
├── public/
├── .env.example
├── .env.local
├── package.json
├── tailwind.config.ts
├── tsconfig.json
└── README.md
```

---

## Structure Principles

| Principle | Implementation |
|-----------|----------------|
| **Feature isolation** | Each feature in `features/` with its own components, hooks, actions |
| **Server/Client separation** | Server-only code in `server/`, prevents accidental client imports |
| **Thin routes** | `app/` only for routing, logic lives in `features/` |
| **Route groups** | `(groupName)/` for layout sharing without URL impact |
| **Shared code** | `shared/` for truly reusable UI and utilities |

---

## Core Files

| File | Purpose |
|------|---------|
| `package.json` | Dependencies |
| `tsconfig.json` | TypeScript + path aliases (`@/features/*`) |
| `tailwind.config.ts` | Tailwind config |
| `.env.example` | Environment template |
| `README.md` | Project documentation |
| `.gitignore` | Git ignore rules |
| `prisma/schema.prisma` | Database schema |

---

## Path Aliases (tsconfig.json)

```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"],
      "@/features/*": ["./src/features/*"],
      "@/shared/*": ["./src/shared/*"],
      "@/server/*": ["./src/server/*"]
    }
  }
}
```

---

## When to Use What

| Need | Location |
|------|----------|
| New page/route | `app/(group)/page.tsx` |
| Feature component | `features/[name]/components/` |
| Server action | `features/[name]/actions.ts` |
| Data fetching | `features/[name]/queries.ts` |
| Reusable button/input | `shared/components/ui/` |
| Database query | `server/db/` |
| External API call | `server/services/` |
