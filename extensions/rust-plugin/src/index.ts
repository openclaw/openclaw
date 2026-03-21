import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";

export interface RustPluginConfig {
  enabled: boolean;
}

function parseConfig(value: unknown): RustPluginConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
  };
}

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

export default definePluginEntry({
  id: "rust-plugin",
  name: "Rust Plugin",
  description: "High-performance plugin powered by Rust",
  configSchema: {
    parse: parseConfig,
    uiHints: {
      enabled: { label: "Enable Plugin" },
    },
  },
  async register(api: OpenClawPluginApi) {
    // Lazy-load the native addon with proper typing
    const nativeAddon =
      (await import("./native/index.cjs")) as typeof import("./native/index.d.ts");

    if (!nativeAddon) {
      api.logger.warn("Native Rust addon not loaded - some features unavailable");
      return;
    }

    const config = parseConfig(api.config?.plugins?.entries?.["rust-plugin"]?.config);

    if (!config.enabled) {
      api.logger.info("Rust plugin disabled by config");
      return;
    }

    // === STRING PROCESSING ===

    api.registerTool({
      name: "rust_process_string",
      label: "Process String",
      description:
        "Process strings with various transformations (uppercase, lowercase, reverse, trim)",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "Input string to process" },
          options: {
            type: "object",
            properties: {
              uppercase: { type: "boolean" },
              lowercase: { type: "boolean" },
              reverse: { type: "boolean" },
              trim: { type: "boolean" },
              remove_spaces: { type: "boolean" },
              remove_newlines: { type: "boolean" },
            },
          },
        },
        required: ["input"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { input: string; options?: Record<string, boolean> };
        const result = await nativeAddon.processString(p.input, p.options || {});
        return json({ success: true, result });
      },
    });

    api.registerTool({
      name: "rust_batch_process",
      label: "Batch Process",
      description: "Process multiple strings in batch with transformations",
      parameters: {
        type: "object",
        properties: {
          inputs: {
            type: "array",
            items: { type: "string" },
            description: "Array of strings to process",
          },
          options: { type: "object", description: "Processing options" },
        },
        required: ["inputs"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { inputs: string[]; options?: Record<string, boolean> };
        const results = await nativeAddon.batchProcess(p.inputs, p.options || {});
        return json({ success: true, results });
      },
    });

    api.registerTool({
      name: "rust_text_stats",
      label: "Text Statistics",
      description: "Get statistics about text (characters, words, lines, bytes)",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to analyze" },
        },
        required: ["text"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { text: string };
        const result = await nativeAddon.textStats(p.text);
        return json(result);
      },
    });

    // === CRYPTOGRAPHY ===

    api.registerTool({
      name: "rust_compute_hash",
      label: "Compute Hash",
      description: "Compute hash of data using various algorithms (sha256, sha512, blake3)",
      parameters: {
        type: "object",
        properties: {
          data: { type: "string", description: "Data to hash" },
          algorithm: {
            type: "string",
            enum: ["sha256", "sha512", "blake3"],
            default: "sha256",
          },
        },
        required: ["data"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { data: string; algorithm?: string };
        const hash = await nativeAddon.computeHash(p.data, p.algorithm || "sha256");
        return json({ algorithm: p.algorithm || "sha256", hash });
      },
    });

    api.registerTool({
      name: "rust_hash_file",
      label: "Hash File",
      description: "Compute hash of a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file" },
          algorithm: {
            type: "string",
            enum: ["sha256", "blake3"],
            default: "sha256",
          },
        },
        required: ["path"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { path: string; algorithm?: string };
        const hash = await nativeAddon.hashFile(p.path, p.algorithm || "sha256");
        return json({ path: p.path, algorithm: p.algorithm || "sha256", hash });
      },
    });

    api.registerTool({
      name: "rust_random_bytes",
      label: "Random Bytes",
      description: "Generate cryptographically secure random bytes",
      parameters: {
        type: "object",
        properties: {
          length: { type: "number", description: "Number of random bytes to generate" },
        },
        required: ["length"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { length: number };
        const bytes = await nativeAddon.randomBytes(p.length);
        return json({ length: p.length, bytes });
      },
    });

    api.registerTool({
      name: "rust_generate_uuid",
      label: "Generate UUID",
      description: "Generate a random UUID v4",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const uuid = nativeAddon.generateUuid();
        return json({ uuid });
      },
    });

    api.registerTool({
      name: "rust_generate_uuids",
      label: "Generate Multiple UUIDs",
      description: "Generate multiple random UUIDs",
      parameters: {
        type: "object",
        properties: {
          count: { type: "number", description: "Number of UUIDs to generate" },
        },
        required: ["count"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { count: number };
        const uuids = nativeAddon.generateUuids(p.count);
        return json({ uuids });
      },
    });

    // === JSON PROCESSING ===

    api.registerTool({
      name: "rust_process_json",
      label: "Process JSON",
      description: "Parse and validate JSON string",
      parameters: {
        type: "object",
        properties: {
          json_string: { type: "string", description: "JSON string to parse" },
        },
        required: ["json_string"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { json_string: string };
        const result = await nativeAddon.processJson(p.json_string);
        return json(result);
      },
    });

    api.registerTool({
      name: "rust_minify_json",
      label: "Minify JSON",
      description: "Minify JSON string (remove whitespace)",
      parameters: {
        type: "object",
        properties: {
          json_string: { type: "string", description: "JSON string to minify" },
        },
        required: ["json_string"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { json_string: string };
        const minified = await nativeAddon.minifyJson(p.json_string);
        return json({ minified });
      },
    });

    api.registerTool({
      name: "rust_prettify_json",
      label: "Prettify JSON",
      description: "Prettify/format JSON string with indentation",
      parameters: {
        type: "object",
        properties: {
          json_string: { type: "string", description: "JSON string to prettify" },
          indent: { type: "number", description: "Indentation spaces" },
        },
        required: ["json_string"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { json_string: string; indent?: number };
        const prettified = await nativeAddon.prettifyJson(p.json_string, p.indent);
        return json({ prettified });
      },
    });

    api.registerTool({
      name: "rust_validate_json",
      label: "Validate JSON",
      description: "Validate JSON and get type information",
      parameters: {
        type: "object",
        properties: {
          json_string: { type: "string", description: "JSON string to validate" },
        },
        required: ["json_string"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { json_string: string };
        const result = await nativeAddon.validateJson(p.json_string);
        return json(result);
      },
    });

    // === FILE SYSTEM ===

    api.registerTool({
      name: "rust_get_file_info",
      label: "Get File Info",
      description: "Get information about a file or directory",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to check" },
        },
        required: ["path"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { path: string };
        const result = await nativeAddon.getFileInfo(p.path);
        return json(result);
      },
    });

    api.registerTool({
      name: "rust_read_file",
      label: "Read File",
      description: "Read file contents as string",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file" },
        },
        required: ["path"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { path: string };
        const content = await nativeAddon.readFileString(p.path);
        return json({ path: p.path, content });
      },
    });

    api.registerTool({
      name: "rust_read_file_buffer",
      label: "Read File Buffer",
      description: "Read file contents as buffer (base64 encoded)",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file" },
        },
        required: ["path"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { path: string };
        const buffer = await nativeAddon.readFileBuffer(p.path);
        return json({ path: p.path, buffer });
      },
    });

    api.registerTool({
      name: "rust_write_file",
      label: "Write File",
      description: "Write string content to a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file" },
          content: { type: "string", description: "Content to write" },
        },
        required: ["path", "content"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { path: string; content: string };
        nativeAddon.writeFileBuffer(p.path, Buffer.from(p.content));
        return json({ success: true, path: p.path });
      },
    });

    api.registerTool({
      name: "rust_list_directory",
      label: "List Directory",
      description: "List contents of a directory",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path" },
        },
        required: ["path"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { path: string };
        const entries = await nativeAddon.listDirectory(p.path);
        return json({ path: p.path, entries });
      },
    });

    api.registerTool({
      name: "rust_create_directory",
      label: "Create Directory",
      description: "Create a directory (including parent directories)",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path to create" },
        },
        required: ["path"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { path: string };
        await nativeAddon.createDirectory(p.path);
        return json({ success: true, path: p.path });
      },
    });

    api.registerTool({
      name: "rust_delete_file",
      label: "Delete File",
      description: "Delete a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to delete" },
        },
        required: ["path"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { path: string };
        await nativeAddon.deleteFile(p.path);
        return json({ success: true, path: p.path });
      },
    });

    api.registerTool({
      name: "rust_delete_directory",
      label: "Delete Directory",
      description: "Delete a directory and all its contents",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path to delete" },
        },
        required: ["path"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { path: string };
        await nativeAddon.deleteDirectory(p.path);
        return json({ success: true, path: p.path });
      },
    });

    api.registerTool({
      name: "rust_copy_file",
      label: "Copy File",
      description: "Copy a file from one location to another",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Source file path" },
          to: { type: "string", description: "Destination file path" },
        },
        required: ["from", "to"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { from: string; to: string };
        const bytesCopied = await nativeAddon.copyFile(p.from, p.to);
        return json({ success: true, from: p.from, to: p.to, bytesCopied });
      },
    });

    // === ENCODING ===

    api.registerTool({
      name: "rust_base64_encode",
      label: "Base64 Encode",
      description: "Encode string to base64",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "String to encode" },
        },
        required: ["input"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { input: string };
        const encoded = nativeAddon.base64Encode(p.input);
        return json({ encoded });
      },
    });

    api.registerTool({
      name: "rust_base64_decode",
      label: "Base64 Decode",
      description: "Decode base64 string",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "Base64 string to decode" },
        },
        required: ["input"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { input: string };
        const decoded = await nativeAddon.base64Decode(p.input);
        return json({ decoded });
      },
    });

    api.registerTool({
      name: "rust_url_encode",
      label: "URL Encode",
      description: "URL encode a string",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "String to URL encode" },
        },
        required: ["input"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { input: string };
        const encoded = nativeAddon.urlEncode(p.input);
        return json({ encoded });
      },
    });

    api.registerTool({
      name: "rust_url_decode",
      label: "URL Decode",
      description: "URL decode a string",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "URL encoded string to decode" },
        },
        required: ["input"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { input: string };
        const decoded = await nativeAddon.urlDecode(p.input);
        return json({ decoded });
      },
    });

    api.registerTool({
      name: "rust_hex_encode",
      label: "Hex Encode",
      description: "Encode bytes to hex string",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "String to encode as hex" },
        },
        required: ["input"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { input: string };
        const encoded = nativeAddon.hexEncode(Buffer.from(p.input));
        return json({ encoded });
      },
    });

    api.registerTool({
      name: "rust_hex_decode",
      label: "Hex Decode",
      description: "Decode hex string to bytes",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "Hex string to decode" },
        },
        required: ["input"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { input: string };
        const buffer = await nativeAddon.hexDecode(p.input);
        return json({ decoded: buffer.toString() });
      },
    });

    // === REGEX ===

    api.registerTool({
      name: "rust_regex_find",
      label: "Regex Find",
      description: "Find all matches of a regex pattern in text",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to search" },
          pattern: { type: "string", description: "Regex pattern" },
        },
        required: ["text", "pattern"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { text: string; pattern: string };
        const result = await nativeAddon.regexFind(p.text, p.pattern);
        return json(result);
      },
    });

    api.registerTool({
      name: "rust_regex_replace",
      label: "Regex Replace",
      description: "Replace all matches of a regex pattern in text",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to process" },
          pattern: { type: "string", description: "Regex pattern" },
          replacement: { type: "string", description: "Replacement string" },
        },
        required: ["text", "pattern", "replacement"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { text: string; pattern: string; replacement: string };
        const result = await nativeAddon.regexReplace(p.text, p.pattern, p.replacement);
        return json({ result });
      },
    });

    api.registerTool({
      name: "rust_regex_test",
      label: "Regex Test",
      description: "Test if text matches a regex pattern",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to test" },
          pattern: { type: "string", description: "Regex pattern" },
        },
        required: ["text", "pattern"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { text: string; pattern: string };
        const matches = await nativeAddon.regexTest(p.text, p.pattern);
        return json({ matches });
      },
    });

    // === PLUGIN META ===

    api.registerTool({
      name: "rust_plugin_info",
      label: "Plugin Info",
      description: "Get information about the Rust plugin",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const result = nativeAddon.getPluginInfo();
        return json(result);
      },
    });

    api.registerTool({
      name: "rust_health_check",
      label: "Health Check",
      description: "Check if the Rust plugin is healthy",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const status = nativeAddon.healthCheck();
        return json({ status });
      },
    });

    api.registerTool({
      name: "rust_benchmark",
      label: "Benchmark",
      description: "Run a simple benchmark",
      parameters: {
        type: "object",
        properties: {
          iterations: { type: "number", description: "Number of iterations" },
        },
        required: ["iterations"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { iterations: number };
        const microseconds = nativeAddon.benchmark(p.iterations);
        return json({ iterations: p.iterations, microseconds });
      },
    });

    // === WEBHOOK HANDLER ===

    api.registerHttpRoute({
      path: "/rust-plugin/webhook",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        const body = await new Promise<string>((resolve) => {
          let data = "";
          req.on("data", (chunk) => (data += chunk));
          req.on("end", () => resolve(data));
        });

        if (nativeAddon?.handleWebhook) {
          const result = await nativeAddon.handleWebhook(body);
          res.statusCode = result.status_code || 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(result));
          return true;
        }

        res.statusCode = 501;
        res.end(JSON.stringify({ error: "Webhook handler not available" }));
        return true;
      },
    });

    api.logger.info("Rust plugin registered successfully");
  },
});
