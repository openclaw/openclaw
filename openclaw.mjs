#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import module from "node:module";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function applyAnthropicThinkingPatch() {
  const isDebug = process.env.OPENCLAW_DEBUG === "1";
  const logDebug = (msg) => {
    if (isDebug) {
      console.error(msg);
    }
  };

  try {
    const modulePath = require.resolve("@mariozechner/pi-ai/dist/providers/anthropic.js");
    const content = fs.readFileSync(modulePath, "utf8");

    const brokenCodeRegex = /thinking:\s*sanitizeSurrogates\(\s*block\.thinking\s*\),/g;
    const fixedCode = "thinking: block.thinking,";

    if (brokenCodeRegex.test(content)) {
      const updatedContent = content.replace(brokenCodeRegex, fixedCode);

      const tempPath = `${modulePath}.patch.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;

      try {
        fs.writeFileSync(tempPath, updatedContent, "utf8");
        fs.renameSync(tempPath, modulePath);
        logDebug("[OpenClaw Patch] Successfully applied Anthropic thinking blocks fix.");
      } catch (writeError) {
        try {
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
        } catch {
          // Ignore cleanup error
        }
        throw writeError;
      }
    }
  } catch (e) {
    // Added EROFS for container/serverless environments
    if (["EACCES", "EPERM", "EROFS"].includes(e.code)) {
      console.warn(
        "⚠️ [OpenClaw Patch] Could not apply Anthropic API fix due to file system restrictions.",
      );
      console.warn(
        "   To fix this safely, adjust your permissions or ensure the filesystem is writable.",
      );
    } else if (e.code !== "MODULE_NOT_FOUND") {
      logDebug(`[OpenClaw Patch] Skipped patch: ${e.message}`);
    }
  }
}

applyAnthropicThinkingPatch();

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
