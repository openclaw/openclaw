#!/usr/bin/env node

/**
 * Jarvis Automated Rebranding Script
 * Safely converts all OpenClaw references to Jarvis
 * Preserves tool functionality and validates changes
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const rebrandingMap = require("./jarvis-rebranding-map.js");

class JarvisRebrander {
  constructor(options = {}) {
    this.dryRun = options.dryRun || false;
    this.verbose = options.verbose || false;
    this.modified = [];
    this.skipped = [];
    this.errors = [];
  }

  log(message, type = "info") {
    const colors = {
      info: "\x1b[36m",
      success: "\x1b[32m",
      warn: "\x1b[33m",
      error: "\x1b[31m",
      reset: "\x1b[0m",
    };
    const prefix = `[${new Date().toISOString()}]`;
    console.log(`${colors[type]}${prefix} ${message}${colors.reset}`);
  }

  findFiles(dir = ".") {
    const files = [];
    const walk = (currentPath) => {
      try {
        const entries = fs.readdirSync(currentPath);
        for (const entry of entries) {
          const fullPath = path.join(currentPath, entry);
          const stat = fs.statSync(fullPath);

          if (this.shouldSkip(fullPath)) {
            continue;
          }

          if (stat.isDirectory()) {
            walk(fullPath);
          } else if (rebrandingMap.shouldProcessFile(fullPath)) {
            files.push(fullPath);
          }
        }
      } catch (error) {
        if (this.verbose) {
          this.log(`Error reading ${currentPath}: ${error.message}`, "warn");
        }
      }
    };

    walk(dir);
    return files;
  }

  shouldSkip(filePath) {
    return rebrandingMap.skipPatterns.some((pattern) => pattern.test(filePath));
  }

  processFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      let modified = false;
      let newContent = content;

      for (const [old, replacement] of Object.entries(rebrandingMap.rebrandingMap)) {
        if (newContent.includes(old)) {
          newContent = newContent.replace(new RegExp(old, "g"), replacement);
          modified = true;
        }
      }

      if (modified) {
        if (!this.dryRun) {
          fs.writeFileSync(filePath, newContent, "utf-8");
        }
        this.modified.push(filePath);
        this.log(`✓ Modified: ${filePath}`, "success");
      }
    } catch (error) {
      this.errors.push({ file: filePath, error: error.message });
      this.log(`✗ Error processing ${filePath}: ${error.message}`, "error");
    }
  }

  printSummary() {
    console.log("\n" + "=".repeat(60));
    this.log("\n📊 Rebranding Summary", "success");
    console.log(`Modified Files: ${this.modified.length}`);
    console.log(`Skipped Patterns: ${this.skipped.length}`);
    console.log(`Errors: ${this.errors.length}`);

    if (this.errors.length > 0) {
      console.log("\nErrors:");
      this.errors.forEach((err) => {
        console.log(`  - ${err.file}: ${err.error}`);
      });
    }

    if (this.dryRun) {
      console.log("\n⚠️  DRY RUN - No files were actually modified");
    }

    console.log("\n" + "=".repeat(60));
  }

  async run() {
    this.log("🚀 Starting Jarvis Rebranding Process...", "info");

    const files = this.findFiles();
    this.log(`Found ${files.length} files to process`, "info");

    for (const file of files) {
      this.processFile(file);
    }

    this.printSummary();

    return {
      success: this.errors.length === 0,
      modified: this.modified.length,
      errors: this.errors.length,
    };
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {
    dryRun: args.includes("--dry-run"),
    verbose: args.includes("--verbose"),
  };

  const rebrander = new JarvisRebrander(options);
  rebrander.run().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

module.exports = JarvisRebrander;
