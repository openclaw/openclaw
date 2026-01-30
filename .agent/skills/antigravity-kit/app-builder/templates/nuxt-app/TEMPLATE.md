---
name: nuxt-app
description: Nuxt 3 full-stack template. Vue 3, Pinia, Tailwind, Prisma.
---

# Nuxt 3 Full-Stack Template

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Nuxt 3 |
| Language | TypeScript |
| UI | Vue 3 (Composition API) |
| State | Pinia |
| Database | PostgreSQL + Prisma |
| Styling | Tailwind CSS |
| Validation | Zod |

---

## Directory Structure

```
project-name/
├── prisma/
│   └── schema.prisma
├── server/
│   ├── api/
│   │   └── [resource]/
│   │       └── index.ts
│   └── utils/
│       └── db.ts         # Prisma client
├── composables/
│   └── useAuth.ts
├── stores/
│   └── user.ts           # Pinia store
├── components/
│   └── ui/
├── pages/
│   ├── index.vue
│   └── [...slug].vue
├── layouts/
│   └── default.vue
├── assets/
│   └── css/
│       └── main.css
├── .env.example
├── nuxt.config.ts
└── package.json
```

---

## Key Concepts

| Concept | Description |
|---------|-------------|
| Auto-imports | Components, composables, utils |
| File-based routing | pages/ → routes |
| Server Routes | server/api/ → API endpoints |
| Composables | Reusable reactive logic |
| Pinia | State management |

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| DATABASE_URL | Prisma connection |
| NUXT_PUBLIC_APP_URL | Public URL |

---

## Setup Steps

1. `npx nuxi@latest init {{name}}`
2. `cd {{name}}`
3. `npm install @pinia/nuxt @prisma/client prisma zod`
4. `npm install -D @nuxtjs/tailwindcss`
5. Add modules to `nuxt.config.ts`:
   ```ts
   modules: ['@pinia/nuxt', '@nuxtjs/tailwindcss']
   ```
6. `npx prisma init`
7. Configure schema
8. `npx prisma db push`
9. `npm run dev`

---

## Best Practices

- Use `<script setup>` for components
- Composables for reusable logic
- Pinia stores in `stores/` folder
- Server routes for API logic
- Auto-import for clean code
- TypeScript for type safety
- See `@[skills/vue-expert]` for Vue patterns
