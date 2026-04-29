# Google GenAI Authentication Guide

The `google-genai` provider in OpenClaw supports two main access paths, which can be configured in three different ways depending on your environment.

---

## Path 1: Gemini API (Google AI Studio)

This is the simplest path and requires a direct API key.

### Configuration

1.  **Obtain an API Key**: Get a key from Google AI Studio.
2.  **Set Environment Variable**:
    ```bash
    export GEMINI_API_KEY="AIzaSy..."
    ```
    _Note: Gemini API keys typically start with `AIzaSy`._

The SDK will automatically use this key if it is present in the environment.

---

## Path 2: Vertex AI (Google Cloud)

This path uses Google Cloud's Vertex AI and relies on Application Default Credentials (ADC). You must ensure that the Vertex AI API is enabled in your Google Cloud project.

You can authenticate in two ways:

### Option A: User Login (Best for Local Development)

If you are working on your local machine and have the Google Cloud SDK (`gcloud`) installed:

1.  **Login**:
    ```bash
    gcloud auth application-default login
    ```
2.  **Set Project and Location**:
    ```bash
    export GOOGLE_CLOUD_PROJECT="your-project-id"
    export GOOGLE_CLOUD_LOCATION="global" # Default to global, use "us-central1" if needed
    ```
    _Ensure you do NOT have `GEMINI_API_KEY` set if you want to force the use of Vertex AI._

### Option B: Service Account Key (Best for Servers/CI/CD or Workarounds)

If `gcloud` login is not working (e.g., on a managed Cloudtop with certificate issues) or you are running on a server:

1.  **Create a Service Account**: In the Google Cloud Console, create a service account and grant it the **Vertex AI User** role (`roles/aiplatform.user`).
2.  **Download Key**: Download the private key in JSON format.
3.  **Set Environment Variables**:
    ```bash
    export GOOGLE_APPLICATION_CREDENTIALS="/path/to/your/service-account-key.json"
    export GOOGLE_CLOUD_PROJECT="your-project-id"
    export GOOGLE_CLOUD_LOCATION="global" # Or "us-central1"
    ```

---

## Running Live Tests

To verify your configuration, you can run the live tests. You must enable them by setting `GEMINI_LIVE_TEST=1`.

### Example: Testing API Key

```bash
GEMINI_LIVE_TEST=1 \
GEMINI_API_KEY="AIzaSy..." \
pnpm exec vitest run src/agents/google-genai.live.test.ts
```

### Example: Testing Vertex AI (Service Account)

```bash
GEMINI_LIVE_TEST=1 \
GOOGLE_CLOUD_PROJECT="your-project-id" \
GOOGLE_CLOUD_LOCATION="global" \
GOOGLE_APPLICATION_CREDENTIALS="/path/to/your/key.json" \
pnpm exec vitest run src/agents/google-genai.live.test.ts
```

### Troubleshooting

#### 1. Node.js / gaxios dynamic import bug
If you encounter an error like `Cannot convert undefined or null to object` originating from `gaxios` when using Vertex AI on Node.js, it may be due to a known bug in how `gaxios` dynamically imports `node-fetch`.

As a workaround (already applied in our test file), you can polyfill `window` at the very top of your entry script:

```typescript
(global as any).window = globalThis;
```

#### 2. Resource Not Found (404) on Vertex AI
If you get a 404 error when using aliases like `gemini-flash-latest` on Vertex AI, it is likely because that alias is not supported in your specific region (e.g., `us-central1`). 

**Solution**: Switch to the `global` location, which supports these aliases:
```bash
export GOOGLE_CLOUD_LOCATION="global"
```
