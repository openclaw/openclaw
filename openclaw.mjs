#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import module from "node:module";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Boot-time patch for Anthropic thinking block signature corruption.
 *
 * Two bugs in @mariozechner/pi-ai cause Anthropic API rejections in
 * multi-turn conversations with extended thinking enabled:
 *
 * 1. transform-messages.js keeps ALL thinking blocks across the entire
 *    conversation history. Anthropic only validates the *latest* assistant
 *    message's thinking blocks — older ones accumulate, waste context tokens,
 *    and can be corrupted by compaction.
 *
 * 2. anthropic.js runs sanitizeSurrogates() on thinking text, which can
 *    strip lone surrogates or other characters, invalidating the
 *    cryptographic signature that Anthropic checks.
 *
 * Fix 1: Strip thinking blocks from all non-latest assistant messages.
 * Fix 2: Preserve thinking text byte-for-byte for the latest assistant message.
 *
 * References:
 *   - https://github.com/openclaw/openclaw/issues/25347
 *   - https://github.com/openclaw/openclaw/issues/25194
 */
function applyAnthropicThinkingPatch() {
  const isDebug = process.env.OPENCLAW_DEBUG === "1";
  const logDebug = (msg) => {
    if (isDebug) console.error(msg);
  };

  const patchFile = (moduleName, patches) => {
    try {
      const modulePath = require.resolve(moduleName);
      let content = fs.readFileSync(modulePath, "utf8");
      let applied = 0;

      for (const { find, replace, label } of patches) {
        if (find instanceof RegExp ? find.test(content) : content.includes(find)) {
          content = find instanceof RegExp
            ? content.replace(find, replace)
            : content.replace(find, replace);
          applied++;
          logDebug(`[OpenClaw Patch] Applied: ${label}`);
        }
      }

      if (applied === 0) {
        logDebug(
          `[OpenClaw Patch] ${moduleName}: no patches needed (already fixed or structure changed)`,
        );
        return;
      }

      // Atomic write: temp file + rename to avoid partial writes on crash
      const tempPath = `${modulePath}.patch.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
      try {
        fs.writeFileSync(tempPath, content, "utf8");
        fs.renameSync(tempPath, modulePath);
        logDebug(`[OpenClaw Patch] ${moduleName}: ${applied} patch(es) applied successfully`);
      } catch (writeError) {
        try {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch {
          /* ignore cleanup error */
        }
        throw writeError;
      }
    } catch (e) {
      if (["EACCES", "EPERM", "EROFS"].includes(e.code)) {
        console.warn(
          "⚠️ [OpenClaw Patch] Could not apply Anthropic thinking fix: read-only filesystem.",
        );
        console.warn(
          "   Ensure the node_modules directory is writable, or apply the fix upstream.",
        );
      } else if (e.code !== "MODULE_NOT_FOUND") {
        logDebug(`[OpenClaw Patch] Skipped: ${e.message}`);
      }
    }
  };

  // Patch 1: transform-messages.js — strip thinking blocks from non-latest assistant messages
  patchFile("@mariozechner/pi-ai/dist/providers/transform-messages.js", [
    {
      label: "strip old thinking blocks (index tracking)",
      find: "const transformed = messages.map((msg) => {",
      replace: [
        "let lastAssistantIndex = -1;",
        "    for (let i = messages.length - 1; i >= 0; i--) {",
        '        if (messages[i].role === "assistant") { lastAssistantIndex = i; break; }',
        "    }",
        "    const transformed = messages.map((msg, msgIndex) => {",
      ].join("\n"),
    },
    {
      label: "strip old thinking blocks (early return)",
      find: /const transformedContent = assistantMsg\.content\.flatMap\(\(block\) => \{\s*if \(block\.type === "thinking"\) \{/,
      replace: [
        "const isLatestAssistant = msgIndex === lastAssistantIndex;",
        "            const transformedContent = assistantMsg.content.flatMap((block) => {",
        '                if (block.type === "thinking") {',
        "                    if (!isLatestAssistant) { return []; }",
      ].join("\n"),
    },
  ]);

  // Patch 2: anthropic.js — skip sanitizeSurrogates on latest assistant's thinking text
  patchFile("@mariozechner/pi-ai/dist/providers/anthropic.js", [
    {
      label: "preserve thinking signature (skip sanitizeSurrogates)",
      find: /thinking:\s*sanitizeSurrogates\(\s*block\.thinking\s*\),\s*\n(\s*)signature:\s*block\.thinkingSignature,/g,
      replace: "thinking: block.thinking,\n$1signature: block.thinkingSignature,",
    },
  ]);
}

applyAnthropicThinkingPatch();

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 12;
const MIN_NODE_VERSION = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`;

const parseNodeVersion = (rawVersion) => {
  const [majorRaw = "0", minorRaw = "0"] = rawVersion.split(".");
  return {
    major: Number(majorRaw),
    minor: Number(minorRaw),
  };
};

const isSupportedNodeVersion = (version) =>
  version.major > MIN_NODE_MAJOR ||
  (version.major === MIN_NODE_MAJOR && version.minor >= MIN_NODE_MINOR);

const ensureSupportedNodeVersion = () => {
  if (isSupportedNodeVersion(parseNodeVersion(process.versions.node))) {
    return;
  }

  process.stderr.write(
    `openclaw: Node.js v${MIN_NODE_VERSION}+ is required (current: v${process.versions.node}).\n` +
      "If you use nvm, run:\n" +
      `  nvm install ${MIN_NODE_MAJOR}\n` +
      `  nvm use ${MIN_NODE_MAJOR}\n` +
      `  nvm alias default ${MIN_NODE_MAJOR}\n`,
  );
  process.exit(1);
};

ensureSupportedNodeVersion();

// https://nodejs.org/api/module.html#module-compile-cache
if (module.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  try {
    module.enableCompileCache();
  } catch {
    // Ignore errors
  }
}

const isModuleNotFoundError = (err) =>
  err && typeof err === "object" && "code" in err && err.code === "ERR_MODULE_NOT_FOUND";

const installProcessWarningFilter = async () => {
  // Keep bootstrap warnings consistent with the TypeScript runtime.
  for (const specifier of ["./dist/warning-filter.js", "./dist/warning-filter.mjs"]) {
    try {
      const mod = await import(specifier);
      if (typeof mod.installProcessWarningFilter === "function") {
        mod.installProcessWarningFilter();
        return;
      }
    } catch (err) {
      if (isModuleNotFoundError(err)) {
        continue;
      }
      throw err;
    }
  }
};

await installProcessWarningFilter();

const tryImport = async (specifier) => {
  try {
    await import(specifier);
    return true;
  } catch (err) {
    // Only swallow missing-module errors; rethrow real runtime errors.
    if (isModuleNotFoundError(err)) {
      return false;
    }
    throw err;
  }
};

if (await tryImport("./dist/entry.js")) {
  // OK
} else if (await tryImport("./dist/entry.mjs")) {
  // OK
} else {
  throw new Error("openclaw: missing dist/entry.(m)js (build output).");
}
