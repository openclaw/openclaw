# Memory (LanceDB) Plugin: Migration Guide

## Overview

The memory-lancedb plugin now supports both **OpenAI** and **Google Gemini** embedding models. This guide helps you understand the options and migrate if needed.

## ⚠️ Critical: Database Compatibility

**Embedding models are NOT compatible with each other** due to different vector dimensions:

- OpenAI small: **1536** dimensions
- OpenAI large: **3072** dimensions
- Google Gemini: **768** dimensions

### Current Status

- ✅ **Adding new provider**: Supported (use `embedding.provider` setting)
- ❌ **Migrating existing data**: NOT supported (requires manual database reset)
- 🔜 **Automatic migration tool**: Planned for future release

**If you switch providers, your existing memories will be lost.** See migration steps below.

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

⚠️ **CRITICAL: Your existing memories are incompatible and must be deleted before switching providers.**

1. **Get a Google API Key**
   - Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
   - Create a new API key
   - Set `GOOGLE_API_KEY` environment variable

2. **BACKUP and DELETE Your Existing Database** ⚠️ **REQUIRED**

   **Step 2a: Backup (Optional but Recommended)**

   Before deleting, consider backing up your memories in case you need them later:

   ```bash
   # Backup the entire database directory
   cp -r ~/.openclaw/memory/lancedb ~/.openclaw/memory/lancedb.backup.openai

   # Or if using custom dbPath:
   cp -r <your-custom-db-path> <your-custom-db-path>.backup.openai
   ```

   This backup will remain compatible with your OpenAI configuration if you need to restore it.

   **Step 2b: Delete the Database**

   After backing up, delete the database to allow the plugin to create a new one with correct dimensions:

   ```bash
   rm -rf ~/.openclaw/memory/lancedb/*
   ```

   This removes all OpenAI-based memories. They cannot be migrated to Google Gemini due to incompatible vector dimensions.

   **Alternative locations (if using custom `dbPath`):**

   ```bash
   rm -rf <your-custom-db-path>/*
   ```

   ⚠️ **After deletion, your memories are gone permanently** (unless you have a backup). The plugin will create a new empty database on next startup.

3. **Update Your Configuration**

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

4. **Restart Your Gateway**

   ```bash
   docker-compose down
   docker-compose up
   ```

5. **Verify It Works**
   Check logs for:

   ```
   memory-lancedb: plugin registered (db: ..., lazy init)
   memory-lancedb: initialized (db: ..., model: gemini-embedding-001)
   ```

   New memories will now be created with Google Gemini embeddings.

## FAQ

### Will My Existing Memories Still Work When I Switch Providers?

**Short answer: NO.**

Memories created with one embedding model are **NOT compatible** with different models because the vector dimensions differ:

- OpenAI small: 1536 dimensions
- Google Gemini: 768 dimensions

When you switch providers, the plugin cannot read old memories because the database schema expects a different vector size. Attempting to use old memories with a new provider will cause errors.

**Solutions:**

1. **Keep using the same provider** (recommended if memories are important)
   - Continue with OpenAI: no action needed
   - Continue with same Gemini model: no action needed

2. **Switch providers and accept data loss**
   - Delete old database before switching:
     ```bash
     rm ~/.openclaw/memory/lancedb/*
     ```
   - Update configuration to new provider
   - Restart gateway
   - Plugin will create a new empty database with correct dimensions

3. **Wait for migration tool** (coming in future release)
   - We're planning a CLI command to automatically migrate data between providers
   - This will re-embed all existing memories with the new provider
   - Check GitHub releases for updates

### Why Different Dimensions?

Each embedding model produces vectors of different sizes:

- Larger dimensions (OpenAI: 3072) = more detailed embeddings, higher cost
- Medium dimensions (OpenAI: 1536) = good balance of quality and cost
- Smaller dimensions (Gemini: 768) = efficient embeddings, lower cost

LanceDB requires all vectors in a table to have the same dimension. This is a fundamental database constraint, not a software limitation.

### Can I Mix Models?

**No.** LanceDB requires all vectors in a table to have the same dimension. You must:

- Use one provider consistently, OR
- Clear memories when switching providers

### How Much Does It Cost?

**Google Gemini:** Free tier available + paid

- Free tier: Limited requests per minute
- Paid: $0.02 per 1 million input tokens
- Cached: $0.004 per 1 million input tokens (from cache)

**OpenAI:** Paid only

- text-embedding-3-small: $0.02 per 1M tokens
- text-embedding-3-large: $0.13 per 1M tokens

**Cost Comparison for typical usage** (assuming 1000 memories, ~100 tokens each):

- Google Gemini: ~$0.002 per full re-embed cycle
- OpenAI small: ~$0.002 per full re-embed cycle
- OpenAI large: ~$0.013 per full re-embed cycle

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
- Model matches provider (gemini-_ for Google, text-embedding-3-_ for OpenAI)

### Memories Not Found After Switch

**This is expected.** Vectors are model-specific and incompatible across dimensions.

**If you regret switching providers:**

If you created a backup before deleting (see migration steps), you can restore it:

```bash
# Restore from your backup (requires you to switch back to OpenAI)
rm -rf ~/.openclaw/memory/lancedb/*
cp -r ~/.openclaw/memory/lancedb.backup.openai ~/.openclaw/memory/lancedb

# Or if using custom dbPath:
rm -rf <your-custom-db-path>/*
cp -r <your-custom-db-path>.backup.openai/* <your-custom-db-path>/
```

Then update your configuration back to the original OpenAI provider and restart.

**⚠️ Without a backup, deleted memories cannot be recovered.** This is why we recommend backing up before making provider changes.

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
