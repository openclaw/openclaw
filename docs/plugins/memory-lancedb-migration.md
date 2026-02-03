# Memory (LanceDB) Plugin: Migration Guide

## Overview

The memory-lancedb plugin now supports both **OpenAI** and **Google Gemini** embedding models. This guide helps you understand the options and migrate if needed.

## Supported Models

| Provider   | Model                  | Dimensions | API Key Env Var  |
| ---------- | ---------------------- | ---------- | ---------------- |
| **OpenAI** | text-embedding-3-small | 1536       | `OPENAI_API_KEY` |
| **OpenAI** | text-embedding-3-large | 3072       | `OPENAI_API_KEY` |
| **Google** | gemini-embedding-001   | 768        | `GOOGLE_API_KEY` |

## Configuration Patterns

### Pattern 1: OpenAI (Default - Existing Users)

If you're already using OpenAI, no changes needed:

```json
{
  "memory": {
    "embedding": {
      "apiKey": "${OPENAI_API_KEY}",
      "model": "text-embedding-3-small"
    }
  }
}
```

Provider automatically detects as "openai" from the model name.

### Pattern 2: Google Gemini (New - Auto-Detect)

To switch to Google Gemini, set the model:

```json
{
  "memory": {
    "embedding": {
      "apiKey": "${GOOGLE_API_KEY}",
      "model": "gemini-embedding-001"
    }
  }
}
```

Provider automatically detects as "google" from the model name.

### Pattern 3: Explicit Provider (Most Explicit)

For clarity or edge cases, explicitly specify the provider:

```json
{
  "memory": {
    "embedding": {
      "apiKey": "${GOOGLE_API_KEY}",
      "provider": "google",
      "model": "gemini-embedding-001"
    }
  }
}
```

## Migration Steps

### From OpenAI to Google Gemini

1. **Get a Google API Key**
   - Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
   - Create a new API key
   - Set `GOOGLE_API_KEY` environment variable

2. **Update Your Configuration**

   From:

   ```json
   {
     "memory": {
       "embedding": {
         "apiKey": "${OPENAI_API_KEY}",
         "model": "text-embedding-3-small"
       }
     }
   }
   ```

   To:

   ```json
   {
     "memory": {
       "embedding": {
         "apiKey": "${GOOGLE_API_KEY}",
         "model": "gemini-embedding-001"
       }
     }
   }
   ```

3. **Restart Your Gateway**

   ```bash
   docker-compose down
   docker-compose up
   ```

4. **Verify It Works**

   Check logs for:

   ```
   memory-lancedb: plugin registered (db: ..., lazy init)
   memory-lancedb: initialized (db: ..., model: gemini-embedding-001)
   ```

## FAQ

### Will My Existing Memories Still Work?

**Important:** Memories created with one embedding model are **NOT compatible** with different models because the vector dimensions differ:

- OpenAI small: 1536 dimensions
- Google Gemini: 768 dimensions

**Action needed:** Either:

1. **Keep using OpenAI** (no changes, your memories stay)
2. **Switch to Gemini and clear memories**:

   ```bash
   rm ~/.openclaw/memory/lancedb/*
   ```

   New memories will be created with Gemini embeddings.

### Why Different Dimensions?

Each embedding model produces vectors of different sizes:

- Larger dimensions (OpenAI: 3072) = more detailed embeddings, higher cost
- Smaller dimensions (Gemini: 768) = efficient embeddings, lower cost

You need to choose based on your use case and budget.

### Can I Mix Models?

**No.** LanceDB requires all vectors in a table to have the same dimension. You must:

- Use one provider consistently, OR
- Clear memories when switching providers

### How Much Does It Cost?

**Google Gemini:** Free tier available

- $0.02 per 1 million input tokens
- $0.04 per 1 million output tokens (cached)

**OpenAI:** Paid only

- text-embedding-3-small: $0.02 per 1M tokens
- text-embedding-3-large: $0.13 per 1M tokens

### What About Response Validation?

The updated plugin now validates Google API responses strictly:

- ✅ Ensures embedding object exists
- ✅ Ensures values array exists and is numeric
- ✅ Throws clear error messages on failures

This prevents silent failures where invalid responses would store zero-vectors.

## Troubleshooting

### Error: "Invalid Google Gemini API response"

**Cause:** Google API returned an unexpected response format

**Solutions:**

1. Verify `GOOGLE_API_KEY` is set correctly
2. Check Google API is enabled in your project
3. Ensure you have quota available
4. Check logs for full error message

### Error: "401 Incorrect API key"

**Cause:** Wrong API key or wrong provider

**Check:**

- For Google: Key starts with `AIza...` not `sk-...`
- For OpenAI: Key starts with `sk-` not `AIza...`
- Model matches provider (`gemini-*` for Google, `text-embedding-3-*` for OpenAI)

### Memories Not Found After Switch

**This is expected.** Vectors are model-specific and incompatible across dimensions.

**Solution:** Delete old memories before switching:

```bash
rm ~/.openclaw/memory/lancedb/*
```

## Configuration Priority

The plugin determines the provider in this order:

1. **Explicit provider field** (if set)

   ```json
   { "embedding": { "provider": "google", ... } }
   ```

2. **Auto-detect from model** (default)
   - Model starts with `gemini-` → google
   - Otherwise → openai

This means you only need to set `provider` if you want to override auto-detection.

## Best Practices

1. ✅ **Use environment variables** for API keys

   ```json
   { "apiKey": "${GOOGLE_API_KEY}" }
   ```

2. ✅ **Be explicit if switching providers** (helps with clarity)

   ```json
   {
     "apiKey": "${GOOGLE_API_KEY}",
     "provider": "google",
     "model": "gemini-embedding-001"
   }
   ```

3. ✅ **Check logs** after config changes

   ```bash
   docker logs <container> | grep memory-lancedb
   ```

4. ✅ **Clear memories** if switching providers

   ```bash
   rm ~/.openclaw/memory/lancedb/*
   ```

## Next Steps

- Read the [Memory (LanceDB) Documentation](https://docs.openclaw.ai/plugins/memory-lancedb)
- Monitor response validation errors in logs
- Report issues on GitHub

Happy remembering! 🧠
