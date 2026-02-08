# Kagi Search Provider Plugin

Example plugin demonstrating how to add custom search providers to Clawdbot's `web_search` tool.

## Installation

1. Copy this directory to your Clawdbot extensions folder
2. Add to your config:

```yaml
plugins:
  load:
    paths:
      - "./extensions/kagi-search"
  entries:
    kagi-search:
      enabled: true
      config:
        apiKey: "your-kagi-api-key"
```

Or set the `KAGI_API_KEY` environment variable.

## Usage

Once installed, set your web search provider to `kagi`:

```yaml
tools:
  web:
    search:
      provider: kagi
```

Now `web_search` will use Kagi instead of Brave or Perplexity.

## Creating Your Own Provider

This example shows the minimal implementation of a search provider:

```typescript
api.registerSearchProvider({
  id: "my-provider",
  label: "My Search Provider",
  description: "Optional description",

  async search(params, ctx) {
    // params: { query, count, country?, search_lang?, ui_lang?, freshness?, providerConfig? }
    // ctx: { config, timeoutSeconds, cacheTtlMs }

    // Implement your search logic here
    const results = await fetchFromYourAPI(params.query);

    return {
      query: params.query,
      provider: "my-provider",
      results: [
        {
          title: "Result title",
          url: "https://example.com",
          description: "Result description",
          published: "2024-01-15", // optional
        },
      ],
      // OR for AI-synthesized answers (like Perplexity):
      // content: "AI-generated answer text",
      // citations: ["https://source1.com", "https://source2.com"],
      tookMs: 123, // optional
    };
  },
});
```

## Provider Types

Two result formats are supported:

### 1. Link Results (like Brave)

```typescript
return {
  query: params.query,
  provider: "my-provider",
  results: [{ title: "...", url: "...", description: "..." }],
};
```

### 2. AI-Synthesized (like Perplexity)

```typescript
return {
  query: params.query,
  provider: "my-provider",
  content: "AI-generated answer",
  citations: ["https://source1.com"],
};
```

## API Key Management

Best practices for API keys:

1. **Environment variable** (simplest):

   ```bash
   export MY_PROVIDER_API_KEY="..."
   ```

2. **Plugin config** (more flexible):

   ```yaml
   plugins:
     entries:
       my-provider:
         config:
           apiKey: "..."
   ```

3. **Access in plugin**:
   ```typescript
   const apiKey =
     ctx.config.plugins?.entries?.["my-provider"]?.config?.apiKey ||
     process.env.MY_PROVIDER_API_KEY;
   ```

## Testing

To test your provider without changing the default:

```yaml
tools:
  web:
    search:
      provider: my-provider
```

Then use the `web_search` tool normally.
