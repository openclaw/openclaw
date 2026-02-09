# MAIBEAUTY .env Template

Copy this template and fill in the values on the new machine.

```env
# === On-Premise LLM (Ollama) ===
OLLAMA_BASE_URL=http://localhost:11434

# === MAIBEAUTY Admin API ===
MAIBEAUTY_API_URL=https://maibeauty-api-production.up.railway.app
MAIBEAUTY_ADMIN_EMAIL=jini@maibeauty.vn
MAIBEAUTY_ADMIN_PASSWORD=<ask-jini>

# === Cloudflare R2 Storage ===
R2_ACCOUNT_ID=<cloudflare-account-id>
R2_ACCESS_KEY_ID=<r2-access-key>
R2_SECRET_ACCESS_KEY=<r2-secret-key>
R2_BUCKET_NAME=maibeauty-media
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_PUBLIC_URL=https://pub-<bucket-id>.r2.dev

# === Cloudflare API ===
CLOUDFLARE_API_TOKEN=<cloudflare-api-token>
CLOUDFLARE_ACCOUNT_ID=<cloudflare-account-id>

# === Video Worker ===
VIDEO_WORKER_KEY=<worker-key-from-railway>

# === Google Sheets CRM ===
GOOGLE_SERVICE_ACCOUNT_JSON=credentials/google-sheets-sa.json
CRM_SPREADSHEET_ID=<spreadsheet-id>

# === KakaoTalk (optional) ===
# KAKAO_REST_API_KEY=
# KAKAO_CLIENT_SECRET=
```

## Where to Find Keys

| Key | Source |
|-----|--------|
| MAIBEAUTY_ADMIN_PASSWORD | Ask 지니 or check source `.env` |
| R2_* | Cloudflare Dashboard → R2 → API Tokens |
| CLOUDFLARE_API_TOKEN | Cloudflare Dashboard → My Profile → API Tokens |
| VIDEO_WORKER_KEY | `railway variables` (MAIBEAUTY project) |
| GOOGLE_SERVICE_ACCOUNT_JSON | Google Cloud Console → IAM → Service Accounts |
