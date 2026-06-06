#!/usr/bin/env node

/**
 * Tools Verification Script
 * Ensures all tools remain functional after rebranding
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

class ToolsVerifier {
  constructor() {
    this.results = {
      passed: [],
      failed: [],
      warnings: [],
    };
  }

  log(message, type = "info") {
    const colors = {
      info: "\x1b[36m",
      success: "\x1b[32m",
      warn: "\x1b[33m",
      error: "\x1b[31m",
      reset: "\x1b[0m",
    };
    console.log(`${colors[type]}${message}${colors.reset}`);
  }

  async verifyCLI() {
    this.log("\n📋 Verifying CLI Availability...", "info");

    try {
      const output = execSync("jarvis --version", { encoding: "utf-8" });
      if (output.includes("Jarvis")) {
        this.results.passed.push("CLI executable found");
        this.log("✓ CLI executable: jarvis", "success");
      } else {
        this.results.warnings.push("CLI version output unexpected");
      }
    } catch (error) {
      this.results.failed.push(`CLI not found: ${error.message}`);
      this.log("✗ CLI not found. Please reinstall.", "error");
    }
  }

  async verifyTools() {
    this.log("\n🔧 Verifying Tool Functionality...", "info");

    const tools = [
      { name: "browser", cmd: "jarvis browser --help" },
      { name: "sessions", cmd: "jarvis sessions list --help" },
      { name: "agent", cmd: "jarvis agent --help" },
      { name: "gateway", cmd: "jarvis gateway --help" },
      { name: "nodes", cmd: "jarvis nodes --help" },
    ];

    for (const tool of tools) {
      try {
        execSync(tool.cmd, { stdio: "pipe", encoding: "utf-8" });
        this.results.passed.push(`Tool: ${tool.name}`);
        this.log(`✓ Tool available: ${tool.name}`, "success");
      } catch (error) {
        if (error.status === 127) {
          this.results.failed.push(`Tool not found: ${tool.name}`);
          this.log(`✗ Tool not found: ${tool.name}`, "error");
        } else {
          this.results.warnings.push(`Tool ${tool.name} returned error code ${error.status}`);
          this.log(`⚠ Tool ${tool.name} check returned: ${error.status}`, "warn");
        }
      }
    }
  }

  async verifyConfig() {
    this.log("\n📁 Verifying Configuration...", "info");

    const homeDir = process.env.JARVIS_HOME || path.join(process.env.HOME, ".jarvis");
    const configFile = path.join(homeDir, "jarvis.json");

    try {
      if (fs.existsSync(configFile)) {
        const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
        this.results.passed.push("Configuration file found and valid");
        this.log(`✓ Config file: ${configFile}`, "success");

        if (config.voice) {
          this.results.passed.push("Voice configuration present");
          this.log("✓ Voice configuration found", "success");
        } else {
          this.results.warnings.push("Voice configuration not found in config");
          this.log("⚠ Voice configuration not in config (optional)", "warn");
        }
      } else {
        this.results.warnings.push(`Config file not found at ${configFile}`);
        this.log(`⚠ Config file not found. Run 'jarvis setup' to initialize.`, "warn");
      }
    } catch (error) {
      this.results.failed.push(`Configuration validation failed: ${error.message}`);
      this.log(`✗ Configuration error: ${error.message}`, "error");
    }
  }

  printReport() {
    console.log("\n" + "=".repeat(70));
    this.log("\n📊 Tool Verification Report", "success");

    console.log(`\n✓ Passed: ${this.results.passed.length}`);
    this.results.passed.forEach((item) => console.log(`  - ${item}`));

    if (this.results.warnings.length > 0) {
      console.log(`\n⚠️  Warnings: ${this.results.warnings.length}`);
      this.results.warnings.forEach((item) => console.log(`  - ${item}`));
    }

    if (this.results.failed.length > 0) {
      console.log(`\n✗ Failed: ${this.results.failed.length}`);
      this.results.failed.forEach((item) => console.log(`  - ${item}`));
    }

    console.log("\n" + "=".repeat(70));

    const totalTests = this.results.passed.length + this.results.failed.length;
    const passRate = totalTests > 0 ? Math.round((this.results.passed.length / totalTests) * 100) : 0;
    console.log(`\nOverall Status: ${passRate}% tests passed`);
  }

  async run() {
    this.log("🔍 Starting Tool Verification...", "info");

    await this.verifyCLI();
    await this.verifyTools();
    await this.verifyConfig();

    this.printReport();

    return this.results.failed.length === 0;
  }
}

if (require.main === module) {
  const verifier = new ToolsVerifier();
  verifier.run().then((success) => {
    process.exit(success ? 0 : 1);
  });
}

module.exports = ToolsVerifier;
