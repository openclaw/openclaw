# SKILL: SOLANA UX ELITE

Guidelines for building premium, high-performance Solana frontends with "Industrial Futurism" aesthetics.

## UI/UX MANDATE

A Solana app should feel like a high-end terminal: precise, responsive, and visually stunning.

### 1. Aesthetic: Industrial Futurism

- **Color Palette**: Dark mode by default. Deep charcoals, electric blues, neon greens (matrix/terminal style).
- **Typography**: Monospace or technical sans-serif (Inter, Roboto Mono, JetBrains Mono).
- **Glassmorphism**: Subtle translucent backgrounds with sharp borders.

### 2. Micro-Animations & Interactivity

- **Haptic Feedback**: Visual "pulses" when a transaction is confirmed.
- **Loading States**: Use "scanning" or "processing" terminal-style animations rather than generic spinners.
- **Hover Effects**: Glow effects on buttons and interactive elements.

### 3. Wallet & Connectivity

- **Wallet Adapter**: Implementation of `@solana/wallet-adapter-react` with custom themed modals.
- **Umi Integration**: Use Metaplex Umi for seamless NFT and standard interaction.

## GEMINI THINKING PROTOCOL
>
> [!IMPORTANT]
> When designing a UI component, use `<think>` to:
>
> 1. Verify that the layout is responsive (mobile-first).
> 2. Check that transaction status transitions (Pending -> Success/Fail) are clearly communicated with appropriate colors (Blue -> Green/Red).
> 3. Ensure that "Industrial Futurism" tokens (spacing, shadows, blurs) are applied consistently.

## BEST PRACTICES

- Optimize for LCP (Largest Contentful Paint) by pre-loading critical font and image assets.
- Use `Transaction Signer` hooks to provide clear progress bars during multi-transaction sequences.
