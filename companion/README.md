# Companion UI

Vite + React + TypeScript + Tailwind + shadcn/ui chat interface for OpenClaw Companion OS.

## Development

```bash
pnpm companion:dev
```

Opens at http://localhost:5174

## Build

```bash
pnpm companion:build
```

Outputs to `dist/companion/`.

## Stack

- **Vite** — build tool and dev server
- **React 19** — UI framework
- **Tailwind CSS v4** — styling
- **shadcn/ui** (radix-maia, stone/rose) — component library
- **Figtree** — font
- **lucide-react** — icons
- **@noble/ed25519** — device identity signing

## Structure

```
src/
├── lib/
│   ├── gateway.ts          # WebSocket RPC client
│   ├── device-auth.ts      # Device auth token storage
│   ├── device-identity.ts  # Ed25519 device keypair
│   └── utils.ts            # cn() helper
├── hooks/
│   └── use-gateway.ts      # React hook wrapping GatewayClient
├── components/
│   ├── ui/                 # shadcn components
│   ├── chat-messages.tsx   # Message list
│   ├── chat-composer.tsx   # Input pill with send button
│   └── streaming-dots.tsx  # Pulsing dots indicator
├── App.tsx                 # Main layout
├── main.tsx                # Entry point
└── index.css               # Theme variables
```

## Gateway

Connects via WebSocket to `ws://127.0.0.1:18789` by default. Override with `?gatewayUrl=` query param. Auth token can be passed via `?token=` (persisted to localStorage).

Session key: `agent:main:companion`
