# Cloudflare R2 Setup For Veil

This is the shortest path to move `wig-forge` asset files into Cloudflare R2.

## 1. Create a bucket

```bash
npx wrangler r2 bucket create veil-assets --location=enam
```

Pick a different bucket name if you want. The code only cares about the final bucket string.

## 2. Create an R2 access key

In Cloudflare Dashboard:

- `R2`
- `Manage R2 API tokens`
- create a token with object write permission for your bucket

You need:

- `accountId`
- `accessKeyId`
- `secretAccessKey`

## 3. Optional but recommended: add a public domain

If you want the room UI to load assets directly from Cloudflare instead of the local `/file` route:

- add an R2 custom domain in dashboard
- point it at the bucket

Example:

`https://assets.example.com`

## 4. Export env vars

```bash
export WIG_FORGE_R2_ACCOUNT_ID="your-account-id"
export WIG_FORGE_R2_BUCKET="veil-assets"
export WIG_FORGE_R2_ACCESS_KEY_ID="your-access-key-id"
export WIG_FORGE_R2_SECRET_ACCESS_KEY="your-secret-access-key"

# optional
export WIG_FORGE_R2_PUBLIC_BASE_URL="https://assets.example.com"
export WIG_FORGE_R2_KEY_PREFIX="veil"
```

## 5. Run a smoke test

```bash
node --import tsx extensions/wig-forge/scripts/r2-smoke.ts
```

What you should see:

- `ok: true`
- the resolved bucket + endpoint
- an uploaded probe object key
- `publicCheck.status: 200` if `WIG_FORGE_R2_PUBLIC_BASE_URL` is already live

By default the probe object is deleted after the test. If you want to keep it:

```bash
WIG_FORGE_R2_SMOKE_KEEP=1 node --import tsx extensions/wig-forge/scripts/r2-smoke.ts
```

## 6. New assets: automatic mirror

Once those vars are present, new forged assets will keep writing locally and also upload:

- `source.*`
- `sprite.png`
- `preview.png`
- `vector.svg`

## 7. Existing assets: backfill

Run this against the shared `storageDir` root:

```bash
node --import tsx extensions/wig-forge/scripts/r2-backfill.ts /absolute/path/to/shared/storage
```

The script scans each inventory folder, uploads missing asset files to R2, and writes the resulting public URLs back into `inventory.json`.

## Notes

- Without `WIG_FORGE_R2_PUBLIC_BASE_URL`, assets still upload to R2, but the room continues serving local file URLs.
- With `WIG_FORGE_R2_PUBLIC_BASE_URL`, current-room cards and spotlight views prefer the Cloudflare-hosted asset URLs.
- Bazaar listing cards also use Cloudflare public URLs when the listing snapshot includes them.
- If the smoke test passes but `publicCheck` is missing or non-200, the bucket credentials are fine and only the public domain step is still pending.
