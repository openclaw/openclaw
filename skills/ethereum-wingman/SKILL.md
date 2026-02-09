---
name: ethereum-wingman
description: Ethereum development tutor and builder for Scaffold-ETH 2 projects. Triggers on "build", "create", "dApp", "smart contract", "Solidity", "DeFi", "Ethereum", "web3", or any blockchain development task. ALWAYS uses fork mode to test against real protocol state.
metadata: {"openclaw":{"emoji":"⚒️","homepage":"https://scaffoldeth.io"}}
---

# Ethereum Wingman

Comprehensive Ethereum development guide for AI agents. Covers smart contract development, DeFi protocols, security best practices, and the SpeedRun Ethereum curriculum.

---

## AI AGENT INSTRUCTIONS - READ THIS FIRST

### 🚫 CRITICAL: External Contracts & Scaffold Hooks

**These rules are MANDATORY. Violations cause real bugs in production.**

1. **ALL CONTRACTS IN externalContracts.ts** — Any contract you want to interact with (tokens, protocols, etc.) MUST be added to `packages/nextjs/contracts/externalContracts.ts` with its address and ABI. Read the file first — the pattern is self-evident.

2. **SCAFFOLD HOOKS ONLY — NEVER RAW WAGMI** — Always use `useScaffoldReadContract` and `useScaffoldWriteContract`, NEVER raw wagmi hooks like `useWriteContract` or `useReadContract`. 

**Why this matters:** Scaffold hooks use `useTransactor` which **waits for transaction confirmation** (not just wallet signing). Raw wagmi's `writeContractAsync` resolves the moment the user signs in MetaMask — BEFORE the tx is mined. This causes buttons to re-enable while transactions are still pending.

```typescript
// ❌ WRONG: Raw wagmi - resolves after signing, not confirmation
const { writeContractAsync } = useWriteContract();
await writeContractAsync({...}); // Returns immediately after MetaMask signs!

// ✅ CORRECT: Scaffold hooks - waits for tx to be mined
const { writeContractAsync } = useScaffoldWriteContract("MyContract");
await writeContractAsync({...}); // Waits for actual on-chain confirmation
```

### 🚨 BEFORE ANY TOKEN/APPROVAL/SECURITY CODE CHANGE
**STOP. Re-read the "Critical Gotchas" section below before writing or modifying ANY code that touches:**
- Token approvals (`approve`, `allowance`, `transferFrom`)
- Token transfers (`transfer`, `safeTransfer`, `safeTransferFrom`)
- Access control or permissions
- Price calculations or oracle usage
- Vault deposits/withdrawals

**This is not optional.** The gotchas section exists because these are the exact mistakes that lose real money. Every time you think "I'll just quickly fix this" is exactly when you need to re-read it.

---

## 🚨 FRONTEND UX RULES (MANDATORY)

**These are HARD RULES, not suggestions. A build is NOT done until all of these are satisfied.**
**These rules have been learned the hard way. Do not skip them.**

### Rule 1: Every Onchain Button — Loader + Disable

ANY button that triggers a blockchain transaction MUST:
1. **Disable immediately** on click
2. **Show a loader/spinner** ("Approving...", "Staking...", etc.)
3. **Stay disabled** until the state updates confirm the action completed
4. **Show success/error feedback** when done

```typescript
// ✅ CORRECT: Separate loading state PER ACTION
const [isApproving, setIsApproving] = useState(false);
const [isStaking, setIsStaking] = useState(false);

<button
  disabled={isApproving}
  onClick={async () => {
    setIsApproving(true);
    try {
      await writeContractAsync({ functionName: "approve", args: [...] });
    } catch (e) {
      console.error(e);
      notification.error("Approval failed");
    } finally {
      setIsApproving(false);
    }
  }}
>
  {isApproving ? "Approving..." : "Approve"}
</button>
```

**❌ NEVER use a single shared `isLoading` for multiple buttons.** Each button gets its own loading state. A shared state causes the WRONG loading text to appear when UI conditionally switches between buttons.

### Rule 2: Three-Button Flow — Network → Approve → Action

When a user needs to approve tokens then perform an action (stake, deposit, swap), there are THREE states. Show exactly ONE button at a time:

```
1. Wrong network?       → "Switch to Base" button
2. Not enough approved? → "Approve" button
3. Enough approved?     → "Stake" / "Deposit" / action button
```

```typescript
// ALWAYS read allowance with a hook (auto-updates when tx confirms)
const { data: allowance } = useScaffoldReadContract({
  contractName: "Token",
  functionName: "allowance",
  args: [address, contractAddress],
});

const needsApproval = !allowance || allowance < amount;
const wrongNetwork = chain?.id !== targetChainId;

{wrongNetwork ? (
  <button onClick={switchNetwork} disabled={isSwitching}>
    {isSwitching ? "Switching..." : "Switch to Base"}
  </button>
) : needsApproval ? (
  <button onClick={handleApprove} disabled={isApproving}>
    {isApproving ? "Approving..." : "Approve $TOKEN"}
  </button>
) : (
  <button onClick={handleStake} disabled={isStaking}>
    {isStaking ? "Staking..." : "Stake"}
  </button>
)}
```

**Critical:** Always read allowance via a hook so UI updates automatically. Never rely on local state alone. If the user clicks Approve while on the wrong network, EVERYTHING BREAKS — that's why wrong network check comes FIRST.

### Rule 3: Address Display — Always `<Address/>`

**EVERY time you display an Ethereum address**, use scaffold-eth's `<Address/>` component.

```typescript
// ✅ CORRECT
import { Address } from "~~/components/scaffold-eth";
<Address address={userAddress} />

// ❌ WRONG — never render raw hex
<span>{userAddress}</span>
<p>0x1234...5678</p>
```

`<Address/>` handles ENS resolution, blockie avatars, copy-to-clipboard, truncation, and block explorer links. Raw hex is unacceptable.

### Rule 3b: Address Input — Always `<AddressInput/>`

**EVERY time the user needs to enter an Ethereum address**, use scaffold-eth's `<AddressInput/>` component.

```typescript
// ✅ CORRECT
import { AddressInput } from "~~/components/scaffold-eth";
<AddressInput value={recipient} onChange={setRecipient} placeholder="Recipient address" />

// ❌ WRONG — never use a raw text input for addresses
<input type="text" value={recipient} onChange={e => setRecipient(e.target.value)} />
```

`<AddressInput/>` provides ENS resolution (type "vitalik.eth" → resolves to address), blockie avatar preview, validation, and paste handling. A raw input gives none of this.

**The pair: `<Address/>` for DISPLAY, `<AddressInput/>` for INPUT. Always.**

### Rule 3c: USD Values — Show Dollar Amounts Everywhere

**EVERY token or ETH amount displayed should include its USD value.**
**EVERY token or ETH input should show a live USD preview.**

```typescript
// ✅ CORRECT — Display with USD
<span>1,000 TOKEN (~$4.20)</span>
<span>0.5 ETH (~$1,250.00)</span>

// ✅ CORRECT — Input with live USD preview
<input value={amount} onChange={...} />
<span className="text-sm text-gray-500">
  ≈ ${(parseFloat(amount || "0") * tokenPrice).toFixed(2)} USD
</span>

// ❌ WRONG — Amount with no USD context
<span>1,000 TOKEN</span>  // User has no idea what this is worth
```

**Where to get prices:**
- **ETH price:** SE2 has a built-in hook — `useNativeCurrencyPrice()` or check the price display component in the bottom-left footer. It reads from mainnet Uniswap V2 WETH/DAI pool.
- **Custom tokens:** Use DexScreener API (`https://api.dexscreener.com/latest/dex/tokens/TOKEN_ADDRESS`), on-chain Uniswap quoter, or Chainlink oracle if available.

**This applies to both display AND input:**
- Displaying a balance? Show USD next to it.
- User entering an amount to send/stake/swap? Show live USD preview below the input.
- Transaction confirmation? Show USD value of what they're about to do.

### Rule 3d: No Duplicate Titles — Header IS the Title

**DO NOT put the app name as an `<h1>` at the top of the page body.** The header already displays the app name. Repeating it wastes space and looks amateur.

```typescript
// ❌ WRONG — AI agents ALWAYS do this
<Header />  {/* Already shows "🦞 $TOKEN Hub" */}
<main>
  <h1>🦞 $TOKEN Hub</h1>  {/* DUPLICATE! Delete this. */}
  <p>Buy, send, and track TOKEN on Base</p>
  ...
</main>

// ✅ CORRECT — Jump straight into content
<Header />  {/* Shows the app name */}
<main>
  <div className="grid grid-cols-2 gap-4">
    {/* Stats, balances, actions — no redundant title */}
  </div>
</main>
```

**The SE2 header component already handles the app title.** Your page content should start with the actual UI — stats, forms, data — not repeat what's already visible at the top of the screen.

### Rule 4: RPC Configuration — ALWAYS Alchemy

**NEVER use public RPCs** (`mainnet.base.org`, etc.) — they rate-limit and cause random failures.

In `scaffold.config.ts`, ALWAYS set:
```typescript
rpcOverrides: {
  [chains.base.id]: "https://base-mainnet.g.alchemy.com/v2/YOUR_KEY",
  [chains.mainnet.id]: "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
},
pollingInterval: 3000,  // 3 seconds, not the default 30000
```

**Monitor RPC usage:** Sensible = 1 request every 3 seconds. If you see 15+ requests/second, you have a bug:
- Hooks re-rendering in loops
- Duplicate hook calls
- Missing dependency arrays
- `watch: true` on hooks that don't need it

### Rule 5: Pre-Publish Checklist

**BEFORE deploying frontend to Vercel/production:**

**Open Graph / Twitter Cards (REQUIRED):**
```typescript
// In app/layout.tsx
export const metadata: Metadata = {
  title: "Your App Name",
  description: "Description of the app",
  openGraph: {
    title: "Your App Name",
    description: "Description of the app",
    images: [{ url: "https://YOUR-LIVE-DOMAIN.com/og-image.png" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Your App Name",
    description: "Description of the app",
    images: ["https://YOUR-LIVE-DOMAIN.com/og-image.png"],
  },
};
```

**⚠️ The OG image URL MUST be:**
- Absolute URL starting with `https://`
- The LIVE production domain (NOT `localhost`, NOT relative path)
- NOT an environment variable that could be unset or localhost
- Actually reachable (test by visiting the URL in a browser)

**Full checklist — EVERY item must pass:**
- [ ] OG image URL is absolute, live production domain
- [ ] OG title and description set (not default SE2 text)
- [ ] Twitter card type set (`summary_large_image`)
- [ ] Favicon updated from SE2 default
- [ ] README updated from SE2 default
- [ ] Footer "Fork me" link → your actual repo (not SE2)
- [ ] Browser tab title is correct
- [ ] RPC overrides set to Alchemy
- [ ] `pollingInterval` is 3000
- [ ] All contract addresses match what's deployed
- [ ] No hardcoded testnet/localhost values in production code
- [ ] Every address display uses `<Address/>`
- [ ] Every onchain button has its own loader + disabled state
- [ ] Approve flow has network check → approve → action pattern

---

## 🧪 BUILD VERIFICATION PROCESS (MANDATORY)

**A build is NOT done when the code compiles. A build is done when you've tested it like a real user.**

### Phase 1: Code QA (Automated)
After writing all code, run the QA check script or spawn a QA sub-agent:
- Scan all `.tsx` files for raw address strings (should use `<Address/>`)
- Scan for shared `isLoading` state across multiple buttons
- Scan for missing `disabled` props on transaction buttons
- Verify `scaffold.config.ts` has `rpcOverrides` and `pollingInterval: 3000`
- Verify `layout.tsx` has OG/Twitter meta with absolute URLs
- Verify no `mainnet.base.org` or other public RPCs in any file

### Phase 2: Smart Contract Testing
- Write and run Foundry tests (`forge test`)
- Test edge cases: zero amounts, max amounts, unauthorized callers
- Test the full user flow in the contract (approve → action → verify state)

### Phase 3: Browser Testing (THE REAL TEST)
**You have a browser. You have a wallet. You have real money. USE THEM.**

After deploying to Base (or fork), open the app and do a FULL walkthrough:

1. **Open the app** in the browser tool — take a snapshot, verify it loaded
2. **Check the page title** — is it correct, not "Scaffold-ETH 2"?
3. **Connect wallet** — does the connect flow work?
4. **Wrong network test** — connect on wrong network, verify "Switch to Base" appears
5. **Switch network** — click the switch button, verify it works
6. **Approve flow** — if the app needs token approval:
   - Verify "Approve" button shows when allowance is insufficient
   - Click Approve — does the button disable? Does it show "Approving..."?
   - Wait for tx — does the button come back? Does the UI update to show the action button?
7. **Main action** — click the primary action (stake, deposit, mint, etc.):
   - Does the button disable and show a loader?
   - Does the transaction go through?
   - Does the UI update after confirmation?
   - Does the balance/state change reflect correctly?
8. **Error handling** — reject a transaction in wallet, verify the UI recovers gracefully
9. **Address displays** — are all addresses showing ENS/blockies, not raw hex?
10. **Share the URL** — check that the OG unfurl looks correct (image, title, description)

**Only after ALL of this passes can you tell the user "it's done."**

### Phase 4: QA Sub-Agent Review (For Complex Builds)
For bigger projects, spawn a sub-agent with a fresh context:
- Give it the repo path and deployed URL
- It reads all frontend code against the rules above
- It opens the browser and clicks through independently
- It reports issues back before shipping

---

### Default Stack: Scaffold-ETH 2 with Fork Mode

When a user wants to BUILD any Ethereum project, follow these steps:

**Step 1: Create Project**

```bash
npx create-eth@latest
# Select: foundry (recommended), target chain, project name
```

**Step 2: Fix Polling Interval**

Edit `packages/nextjs/scaffold.config.ts` and change:
```typescript
pollingInterval: 30000,  // Default: 30 seconds (way too slow!)
```
to:
```typescript
pollingInterval: 3000,   // 3 seconds (much better for development)
```

**Step 3: Install & Fork a Live Network**

```bash
cd <project-name>
yarn install
yarn fork --network base  # or mainnet, arbitrum, optimism, polygon
```

**⚠️ IMPORTANT: When using fork mode, the frontend target network MUST be `chains.foundry` (chain ID 31337), NOT the chain you're forking!**

The fork runs locally on Anvil with chain ID 31337. Even if you're forking Base, Arbitrum, etc., the scaffold config must use:
```typescript
targetNetworks: [chains.foundry],  // NOT chains.base!
```
Only switch to `chains.base` (or other chain) when deploying to the REAL network.

**Step 4: Enable Auto Block Mining (REQUIRED!)**

```bash
# In a new terminal, enable interval mining (1 block/second)
cast rpc anvil_setIntervalMining 1
```

Without this, `block.timestamp` stays FROZEN and time-dependent logic breaks!

**Optional: Make it permanent** by editing `packages/foundry/package.json` to add `--block-time 1` to the fork script.

**Step 5: Deploy to Local Fork (FREE!)**

```bash
yarn deploy
```

**Step 6: Start Frontend**

```bash
yarn start
```

**Step 7: Test the Frontend**

After the frontend is running, open a browser and test the app:

1. **Navigate** to `http://localhost:3000`
2. **Take a snapshot** to get page elements (burner wallet address is in header)
3. **Click the faucet** to fund the burner wallet with ETH
4. **Transfer tokens** from whales if needed (use burner address from page)
5. **Click through the app** to verify functionality

Use the `cursor-browser-extension` MCP tools for browser automation.
See `tools/testing/frontend-testing.md` for detailed workflows.

### When Publishing a Scaffold-ETH 2 Project:

1. **Update README.md** — Replace the default SE2 readme with your project's description
2. **Update the footer link** — In `packages/nextjs/components/Footer.tsx`, change the "Fork me" link from `https://github.com/scaffold-eth/se-2` to your actual repo URL
3. **Update page title** — In `packages/nextjs/app/layout.tsx`, change the metadata title/description
4. **Remove "Debug Contracts" nav link** — In `packages/nextjs/components/Header.tsx`, remove the Debug Contracts entry from `menuLinks`
5. **Set OG/Twitter meta** — Follow the Pre-Publish Checklist in Rule 5 above

### 🚀 SE2 Deployment Quick Decision Tree

```
Want to deploy SE2 to production?
│
├─ IPFS (recommended) ──→ yarn ipfs (local build, no memory limits)
│   └─ Fails with "localStorage.getItem is not a function"?
│       └─ Add NODE_OPTIONS="--require ./polyfill-localstorage.cjs"
│          (Node 25+ has broken localStorage — see below)
│
├─ Vercel ──→ Set rootDirectory=packages/nextjs, installCommand="cd ../.. && yarn install"
│   ├─ Fails with "No Next.js version detected"?
│   │   └─ Root Directory not set — fix via Vercel API or dashboard
│   ├─ Fails with "cd packages/nextjs: No such file or directory"?
│   │   └─ Build command still has "cd packages/nextjs" — clear it (root dir handles this)
│   └─ Fails with OOM / exit code 129?
│       └─ Build machine can't handle SE2 monorepo — use IPFS instead or vercel --prebuilt
│
└─ Any path: "TypeError: localStorage.getItem is not a function"
    └─ Node 25+ bug. Use --require polyfill (see IPFS section below)
```

### Deploying SE2 to Vercel (Monorepo Setup):

SE2 is a monorepo — Vercel needs special configuration:

1. **Set Root Directory** to `packages/nextjs` in Vercel project settings
2. **Set Install Command** to `cd ../.. && yarn install` (installs from workspace root)
3. **Leave Build Command** as default (`next build` — auto-detected)
4. **Leave Output Directory** as default (`.next`)

**Via Vercel API:**
```bash
curl -X PATCH "https://api.vercel.com/v9/projects/PROJECT_ID" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"rootDirectory": "packages/nextjs", "installCommand": "cd ../.. && yarn install"}'
```

**Via CLI (after linking):**
```bash
cd your-se2-project && vercel --prod --yes
```

**⚠️ Common mistake:** Don't put `cd packages/nextjs` in the build command — Vercel is already in `packages/nextjs` because of the root directory setting. Don't use a root-level `vercel.json` with `framework: "nextjs"` — Vercel can't find Next.js in the root package.json and fails.

**⚠️ Vercel OOM (Out of Memory):** SE2's full monorepo install (foundry + nextjs + all deps) can exceed Vercel's 8GB build memory. If build fails with "Out of Memory" / exit code 129:
- **Option A:** Add env var `NODE_OPTIONS=--max-old-space-size=7168`
- **Option B (recommended):** Build locally and push to IPFS instead (`yarn ipfs`)
- **Option C:** Use `vercel --prebuilt` (build locally, deploy output to Vercel)

### Deploying SE2 to IPFS (BuidlGuidl IPFS):

**This is the RECOMMENDED deploy path for SE2.** Avoids Vercel's memory limits entirely.

```bash
cd packages/nextjs
NODE_OPTIONS="--require ./polyfill-localstorage.cjs" NEXT_PUBLIC_IPFS_BUILD=true NEXT_PUBLIC_IGNORE_BUILD_ERROR=true yarn build
yarn bgipfs upload config init -u https://upload.bgipfs.com -k "$BGIPFS_API_KEY"
yarn bgipfs upload out
```

Or use the built-in script (if it includes the polyfill):
```bash
yarn ipfs
```

**⚠️ CRITICAL: Node 25+ localStorage Bug**

Node.js 25+ ships a built-in `localStorage` object that's MISSING standard WebStorage API methods (`getItem`, `setItem`, etc.). This breaks `next-themes`, RainbowKit, and any library that calls `localStorage.getItem()` during static page generation (SSG/export).

**Error you'll see:**
```
TypeError: localStorage.getItem is not a function
Error occurred prerendering page "/_not-found"
```

**The fix:** Create `polyfill-localstorage.cjs` in `packages/nextjs/`:
```javascript
// Polyfill localStorage for Node 25+ static export builds
if (typeof globalThis.localStorage !== "undefined" && typeof globalThis.localStorage.getItem !== "function") {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() { return store.size; },
  };
}
```

Then prefix the build with: `NODE_OPTIONS="--require ./polyfill-localstorage.cjs"`

**Why `--require` and not `instrumentation.ts` or `next.config.ts`?**
- `next.config.ts` polyfill runs in the main process only
- `instrumentation.ts` doesn't run in the build worker
- `--require` injects into EVERY Node process, including build workers ✅

**Why this happens:** The polyfill is needed because Next.js spawns a separate build worker process for prerendering static pages. That worker inherits `NODE_OPTIONS`, so `--require` is the only way to guarantee the polyfill runs before any library code.

**⚠️ blockexplorer pages:** SE2's built-in block explorer uses `localStorage` at import time and will also fail during static export. Either disable it (rename `app/blockexplorer` to `app/_blockexplorer-disabled`) or ensure the polyfill is active.

### 🚨 STALE BUILD / STALE DEPLOY — THE #1 IPFS FOOTGUN

**Problem:** You edit `page.tsx`, then give the user the OLD IPFS URL from a previous deploy. The code changes are in the source but the `out/` directory still contains the old build. This has happened MULTIPLE TIMES.

**Root cause:** The build step (`yarn build`) produces `out/`. If you edit source files AFTER building but BEFORE deploying, the deploy uploads stale output. Or worse — you skip rebuilding entirely and just re-upload the old `out/`.

**MANDATORY: After ANY code change, ALWAYS do the full cycle:**
```bash
# 1. Delete old build artifacts (prevents any caching)
rm -rf .next out

# 2. Rebuild from scratch
NODE_OPTIONS="--require ./polyfill-localstorage.cjs" NEXT_PUBLIC_IPFS_BUILD=true NEXT_PUBLIC_IGNORE_BUILD_ERROR=true yarn build

# 3. VERIFY the new build has your changes (spot-check the JS bundle)
grep -l "YOUR_UNIQUE_STRING" out/_next/static/chunks/app/*.js

# 4. Only THEN upload
yarn bgipfs upload out
```

**How to detect a stale deploy:**
```bash
# Compare timestamps — source must be OLDER than out/
stat -f '%Sm' app/page.tsx       # source modified time
stat -f '%Sm' out/               # build output time
# If source is NEWER than out/ → BUILD IS STALE, rebuild first!
```

**The CID is your proof:** If the IPFS CID didn't change after a deploy, you deployed the same content. A real code change ALWAYS produces a new CID.

### 🚨 IPFS ROUTING — WHY ROUTES BREAK AND HOW TO FIX

IPFS gateways serve static files. There's no server to handle routing. Three things MUST be true for routes like `/debug` to work:

**1. `output: "export"` in next.config.ts**
Without this, Next.js builds for server rendering — no static HTML files are generated, so IPFS has nothing to serve.

**2. `trailingSlash: true` in next.config.ts (CRITICAL)**
This is the #1 reason routes break on IPFS:
- `trailingSlash: false` (default) → generates `debug.html`
- `trailingSlash: true` → generates `debug/index.html`

IPFS gateways resolve directories to `index.html` automatically, but they do NOT resolve bare filenames. So `/debug` → looks for directory `debug/` → finds `index.html` ✅. Without trailing slash, `/debug` → no directory, no file match → 404 ❌.

**3. Routes must survive static export prerendering**
During `yarn build` with `output: "export"`, Next.js prerenders every page to HTML. If a page crashes during prerender (e.g., hooks that need browser APIs, `localStorage.getItem is not a function`), that route gets SKIPPED — no HTML file is generated, and it 404s on IPFS.

Common prerender killers:
- `localStorage` / `sessionStorage` usage at import time
- Hooks that assume browser environment (`window`, `document`)
- SE2's block explorer pages (use `localStorage` at import time — rename to `_blockexplorer-disabled` if not needed)

**How to verify routes after build:**
```bash
# Check that out/ has a directory + index.html for each route
ls out/*/index.html
# Should show: out/debug/index.html, out/other-route/index.html, etc.

# Verify specific route
curl -s -o /dev/null -w "%{http_code}" -L "https://YOUR_GATEWAY/ipfs/CID/debug/"
# Should return 200, not 404
```

**The complete IPFS-safe next.config.ts pattern:**
```typescript
const isIpfs = process.env.NEXT_PUBLIC_IPFS_BUILD === "true";
if (isIpfs) {
  nextConfig.output = "export";       // static HTML generation
  nextConfig.trailingSlash = true;    // route/index.html (IPFS needs this!)
  nextConfig.images = {
    unoptimized: true,                // no image optimization server on IPFS
  };
}
```

### 🚀 GO TO PRODUCTION — Full Checklist

When the user says "ship it", follow this EXACT sequence.
Steps marked 🤖 are fully automatic. Steps marked 👤 need human input.

---

**Step 1: 🤖 Final code review**
- Verify all feedback is incorporated in source code
- Test locally (`yarn start`) one last time
- Check for common issues: duplicate h1, missing AddressInput, raw text inputs

**Step 2: 👤 Ask the user what domain they want**
Ask: *"What subdomain do you want for this? e.g. `token.yourname.eth` → `token.yourname.eth.limo`"*
Save the answer — it determines the production URL for metadata + ENS setup.

**Step 3: 🤖 Generate OG image + fix metadata for unfurls**

Social unfurls (Twitter, Telegram, Discord, etc.) need THREE things correct:
1. **Custom OG image** (1200x630 PNG) — NOT the stock SE2 thumbnail
2. **Absolute production URL** in og:image — NOT `localhost:3000`
3. **`twitter:card` set to `summary_large_image`** for large preview

**Generate the OG image** (`public/thumbnail.png`, 1200x630):
```python
# Use PIL/Pillow to create a branded 1200x630 OG image with:
# - App name and tagline
# - Production URL (name.yourname.eth.limo)
# - Dark background, clean layout, accent colors
# Save to: packages/nextjs/public/thumbnail.png
```

**Fix metadata baseUrl** — ensure `utils/scaffold-eth/getMetadata.ts` supports `NEXT_PUBLIC_PRODUCTION_URL`:
```typescript
const baseUrl = process.env.NEXT_PUBLIC_PRODUCTION_URL
  ? process.env.NEXT_PUBLIC_PRODUCTION_URL
  : process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `http://localhost:${process.env.PORT || 3000}`;
```
If this env var pattern is already in the file, skip this step.

**Step 4: 🤖 Clean build + IPFS deploy**
```bash
cd packages/nextjs
rm -rf .next out

NEXT_PUBLIC_PRODUCTION_URL="https://<name>.yourname.eth.limo" \
  NODE_OPTIONS="--require ./polyfill-localstorage.cjs" \
  NEXT_PUBLIC_IPFS_BUILD=true NEXT_PUBLIC_IGNORE_BUILD_ERROR=true \
  yarn build

# VERIFY (all 3 must pass before uploading):
ls out/*/index.html                              # routes exist
grep 'og:image' out/index.html                   # NOT localhost
stat -f '%Sm' app/page.tsx && stat -f '%Sm' out/ # source older than build

# Upload:
yarn bgipfs upload out
# Save the CID!
```

**Step 5: 👤 Share IPFS URL for verification**
Send: *"Here's the build for review: `https://community.bgipfs.com/ipfs/<CID>`"*
**Wait for approval before touching ENS.** Don't proceed until the user says go.

**Step 6: 🤖 Set up ENS subdomain (2 mainnet transactions)**

If this is a **new app** (subdomain doesn't exist yet):

**Tx #1 — Create subdomain:**
1. Open `https://app.ens.domains/yourname.eth` in the wallet browser (your wallet profile)
2. Go to "Subnames" tab → "New subname"
3. Enter the label (e.g. `token`) → Next → Skip profile → Open Wallet → Confirm
4. If gas is stuck: switch MetaMask to Ethereum network → Activity tab → "Speed up"

**Tx #2 — Set IPFS content hash:**
1. Navigate to `https://app.ens.domains/<name>.yourname.eth`
2. Go to "Records" tab → "Edit Records" → "Other" tab
3. Paste in Content Hash field: `ipfs://<CID>`
4. Save → Open Wallet → Confirm in MetaMask

If this is an **update** to an existing app: skip Tx #1, only do Tx #2 (update the content hash).

**Step 7: 🤖 Verify everything**
```bash
# 1. ENS content hash matches (on-chain)
RESOLVER=$(cast call 0x00000000000C2e074eC69A0dFb2997BA6C7d2e1e \
  "resolver(bytes32)(address)" $(cast namehash <name>.yourname.eth) \
  --rpc-url https://eth-mainnet.g.alchemy.com/v2/<KEY>)
cast call $RESOLVER "contenthash(bytes32)(bytes)" \
  $(cast namehash <name>.yourname.eth) --rpc-url <RPC>

# 2. .limo gateway responds (may take a few minutes for cache)
curl -s -o /dev/null -w "%{http_code}" -L "https://<name>.yourname.eth.limo"

# 3. OG metadata correct
curl -s -L "https://<name>.yourname.eth.limo" | grep 'og:image'
# Should show the production URL, NOT localhost
```

**Step 8: 👤 Report to the user**
Send: *"Live at `https://<name>.yourname.eth.limo` — unfurl metadata set, ENS content hash confirmed on-chain."*

---

**⚠️ Known gotchas:**
- **MetaMask gas:** ENS app sometimes suggests 0.2 gwei — mainnet needs more. Use "Speed up" if stuck.
- **.limo caching:** Gateway caches content for ~5-15 min. On-chain hash updates immediately but .limo may serve stale content briefly.
- **Stock thumbnail:** SE2 ships a default `thumbnail.png` and `thumbnail.jpg`. ALWAYS replace both before production.
- **localhost in metadata:** If `NEXT_PUBLIC_PRODUCTION_URL` isn't set, og:image will point to `localhost:3000`. Always verify with `grep`.

### DO NOT:

- Run `yarn chain` (use `yarn fork --network <chain>` instead!)
- Manually run `forge init` or set up Foundry from scratch
- Manually create Next.js projects  
- Set up wallet connection manually (SE2 has RainbowKit pre-configured)

### Why Fork Mode?

```
yarn chain (WRONG)              yarn fork --network base (CORRECT)
└─ Empty local chain            └─ Fork of real Base mainnet
└─ No protocols                 └─ Uniswap, Aave, etc. available
└─ No tokens                    └─ Real USDC, WETH exist
└─ Testing in isolation         └─ Test against REAL state
```

### Address Data Available

Token, protocol, and whale addresses are in `data/addresses/`:
- `tokens.json` - WETH, USDC, DAI, etc. per chain
- `protocols.json` - Uniswap, Aave, Chainlink per chain  
- `whales.json` - Large token holders for test funding

---

## THE MOST CRITICAL CONCEPT

**NOTHING IS AUTOMATIC ON ETHEREUM.**

Smart contracts cannot execute themselves. There is no cron job, no scheduler, no background process. For EVERY function that "needs to happen":

1. Make it callable by **ANYONE** (not just admin)
2. Give callers a **REASON** (profit, reward, their own interest)
3. Make the incentive **SUFFICIENT** to cover gas + profit

**Always ask: "Who calls this function? Why would they pay gas?"**

If you can't answer this, your function won't get called.

### Examples of Proper Incentive Design

```solidity
// LIQUIDATIONS: Caller gets bonus collateral
function liquidate(address user) external {
    require(getHealthFactor(user) < 1e18, "Healthy");
    uint256 bonus = collateral * 5 / 100; // 5% bonus
    collateralToken.transfer(msg.sender, collateral + bonus);
}

// YIELD HARVESTING: Caller gets % of harvest
function harvest() external {
    uint256 yield = protocol.claimRewards();
    uint256 callerReward = yield / 100; // 1%
    token.transfer(msg.sender, callerReward);
}

// CLAIMS: User wants their own tokens
function claimRewards() external {
    uint256 reward = pendingRewards[msg.sender];
    pendingRewards[msg.sender] = 0;
    token.transfer(msg.sender, reward);
}
```

---

## Critical Gotchas (Memorize These)

### 1. Token Decimals Vary

**USDC = 6 decimals, not 18!**

```solidity
// BAD: Assumes 18 decimals - transfers 1 TRILLION USDC!
uint256 oneToken = 1e18;

// GOOD: Check decimals
uint256 oneToken = 10 ** token.decimals();
```

Common decimals:
- USDC, USDT: 6 decimals
- WBTC: 8 decimals
- Most tokens (DAI, WETH): 18 decimals

### 2. ERC-20 Approve Pattern Required

Contracts cannot pull tokens directly. Two-step process:

```solidity
// Step 1: User approves
token.approve(spenderContract, amount);

// Step 2: Contract pulls tokens
token.transferFrom(user, address(this), amount);
```

**Never use infinite approvals:**
```solidity
// DANGEROUS
token.approve(spender, type(uint256).max);

// SAFE
token.approve(spender, exactAmount);
```

### 3. No Floating Point in Solidity

Use basis points (1 bp = 0.01%):

```solidity
// BAD: This equals 0
uint256 fivePercent = 5 / 100;

// GOOD: Basis points
uint256 FEE_BPS = 500; // 5% = 500 basis points
uint256 fee = (amount * FEE_BPS) / 10000;
```

### 4. Reentrancy Attacks

External calls can call back into your contract:

```solidity
// SAFE: Checks-Effects-Interactions pattern
function withdraw() external nonReentrant {
    uint256 bal = balances[msg.sender];
    balances[msg.sender] = 0; // Effect BEFORE interaction
    (bool success,) = msg.sender.call{value: bal}("");
    require(success);
}
```

Always use OpenZeppelin's ReentrancyGuard.

### 5. Never Use DEX Spot Prices as Oracles

Flash loans can manipulate spot prices instantly:

```solidity
// SAFE: Use Chainlink
function getPrice() internal view returns (uint256) {
    (, int256 price,, uint256 updatedAt,) = priceFeed.latestRoundData();
    require(block.timestamp - updatedAt < 3600, "Stale");
    require(price > 0, "Invalid");
    return uint256(price);
}
```

### 6. Vault Inflation Attack

First depositor can steal funds via share manipulation:

```solidity
// Mitigation: Virtual offset
function convertToShares(uint256 assets) public view returns (uint256) {
    return assets.mulDiv(totalSupply() + 1e3, totalAssets() + 1);
}
```

### 7. Use SafeERC20

Some tokens (USDT) don't return bool on transfer:

```solidity
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
using SafeERC20 for IERC20;

token.safeTransfer(to, amount); // Handles non-standard tokens
```

---

## Scaffold-ETH 2 Development

### Project Structure
```
packages/
├── foundry/              # Smart contracts
│   ├── contracts/        # Your Solidity files
│   └── script/           # Deploy scripts
└── nextjs/
    ├── app/              # React pages
    └── contracts/        # Generated ABIs + externalContracts.ts
```

### Essential Hooks
```typescript
// Read contract data
const { data } = useScaffoldReadContract({
  contractName: "YourContract",
  functionName: "greeting",
});

// Write to contract
const { writeContractAsync } = useScaffoldWriteContract("YourContract");

// Watch events
useScaffoldEventHistory({
  contractName: "YourContract",
  eventName: "Transfer",
  fromBlock: 0n,
});
```

---

## SpeedRun Ethereum Challenges

Reference these for hands-on learning:

| Challenge | Concept | Key Lesson |
|-----------|---------|------------|
| 0: Simple NFT | ERC-721 | Minting, metadata, tokenURI |
| 1: Staking | Coordination | Deadlines, escrow, thresholds |
| 2: Token Vendor | ERC-20 | Approve pattern, buy/sell |
| 3: Dice Game | Randomness | On-chain randomness is insecure |
| 4: DEX | AMM | x*y=k formula, slippage |
| 5: Oracles | Price Feeds | Chainlink, manipulation resistance |
| 6: Lending | Collateral | Health factor, liquidation incentives |
| 7: Stablecoins | Pegging | CDP, over-collateralization |
| 8: Prediction Markets | Resolution | Outcome determination |
| 9: ZK Voting | Privacy | Zero-knowledge proofs |
| 10: Multisig | Signatures | Threshold approval |
| 11: SVG NFT | On-chain Art | Generative, base64 encoding |

---

## DeFi Protocol Patterns

### Uniswap (AMM)
- Constant product formula: x * y = k
- Slippage protection required
- LP tokens represent pool share

### Aave (Lending)
- Supply collateral, borrow assets
- Health factor = collateral value / debt value
- Liquidation when health factor < 1

### ERC-4626 (Tokenized Vaults)
- Standard interface for yield-bearing vaults
- deposit/withdraw with share accounting
- Protect against inflation attacks

---

## Security Review Checklist

Before deployment, verify:
- [ ] Access control on all admin functions
- [ ] Reentrancy protection (CEI + nonReentrant)
- [ ] Token decimal handling correct
- [ ] Oracle manipulation resistant
- [ ] Integer overflow handled (0.8+ or SafeMath)
- [ ] Return values checked (SafeERC20)
- [ ] Input validation present
- [ ] Events emitted for state changes
- [ ] Incentives designed for maintenance functions
- [ ] NO infinite approvals (use exact amounts, NEVER type(uint256).max)

---

## Response Guidelines

When helping developers:

1. **Follow the fork workflow** - Always use `yarn fork`, never `yarn chain`
2. **Answer directly** - Address their question first
3. **Show code** - Provide working examples
4. **Warn about gotchas** - Proactively mention relevant pitfalls
5. **Reference challenges** - Point to SpeedRun Ethereum for practice
6. **Ask about incentives** - For any "automatic" function, ask who calls it and why
