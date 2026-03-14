# PR: Add autoVisualInput option for browser screenshots

## Summary

This PR adds a new configuration option `browser.autoVisualInput` that allows screenshots captured via `openclaw browser screenshot` to be automatically output as visual input for multi-modal models.

## Motivation

When using OpenClaw with multi-modal models (e.g., Qwen-VL, GPT-4V, Claude-3.5 Sonnet), users often need to analyze web pages through screenshots. Previously, screenshots were only saved as files and output as paths (`MEDIA:<path>`), but the actual image data was not passed to the model.

This feature enables the model to "see" screenshot content directly, making browser automation and web page analysis much more powerful.

## Changes

### 1. Configuration Schema (`src/config/types.browser.ts`)

Added new optional field to `BrowserConfig`:

```typescript
/**
 * If true, automatically output screenshot images as visual input when using browser screenshot.
 * This allows the model to "see" the screenshot content when analyzing web pages.
 * Default: false
 */
autoVisualInput?: boolean;
```

### 2. Zod Validation Schema (`src/config/zod-schema.ts`)

Added validation for the new field:

```typescript
autoVisualInput: z.boolean().optional(),
```

### 3. Browser CLI (`src/cli/browser-cli-inspect.ts`)

Modified the `screenshot` command to output image data when enabled:

```typescript
defaultRuntime.log(`MEDIA:${shortenHomePath(result.path)}`);
// 如果配置了 autoVisualInput，输出 VISUAL_INPUT 标记
const config = loadConfig();
if (config?.browser?.autoVisualInput) {
  const fs = await import("node:fs/promises");
  const buffer = await fs.readFile(result.path);
  const base64 = buffer.toString("base64");
  defaultRuntime.log(`VISUAL_INPUT:image/png;base64,${base64}`);
}
```

## Usage

### Enable the feature

```bash
openclaw config set browser.autoVisualInput true
openclaw gateway restart
```

### Disable the feature

```bash
openclaw config set browser.autoVisualInput false
openclaw gateway restart
```

### Example output

With `autoVisualInput: true`, running `openclaw browser screenshot` outputs:

```
MEDIA:/home/k/.openclaw/media/browser/abc123.jpg
VISUAL_INPUT:image/png;base64,/9j/4AAQSkZJRgABAQEAYABgAAD...
```

The model can then process both the file path and the image data.

## Benefits

1. **Better web page analysis**: Models can see charts, 3D scenes, and visual content
2. **Automated testing**: Visual regression testing becomes possible
3. **Accessibility**: Multi-modal models can describe page content more accurately
4. **Configurable**: Opt-in feature, doesn't affect existing workflows

## Considerations

### Token usage

Base64-encoded images can be large (e.g., 1MB image ≈ 700-1000 tokens). Users should be aware of potential cost implications.

### Model compatibility

This feature only works with multi-modal models. Pure text models will ignore the `VISUAL_INPUT` output.

### Performance

Reading and encoding images adds some overhead. For frequent screenshots, this may impact response time.

## Testing

Tested with:
- Qwen3.5-122B-A10B (multi-modal version)
- Browser screenshots on localhost:3000
- Visual input passed to model successfully

## Future improvements

1. Add `--visual` CLI flag for one-time use without config change
2. Add image compression options to reduce token usage
3. Add model capability detection to auto-enable/disable
4. Support for other visual input formats (JPEG, WebP)

## Related issues

Closes # (add issue number if applicable)
