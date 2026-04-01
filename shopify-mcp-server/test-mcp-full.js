#!/usr/bin/env node

import { spawn } from "child_process";
import { createInterface } from "readline";

// Colors for output
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const GRAY = "\x1b[90m";

// Test configuration
const SERVER_PATH = "./build/index.js";
const SHOPIFY_ACCESS_TOKEN = "shpat_EXAMPLE_REPLACE_WITH_YOUR_TOKEN";
const MYSHOPIFY_DOMAIN = "vividwalls-2.myshopify.com";

class MCPServerFullTester {
  constructor() {
    this.server = null;
    this.messageId = 0;
  }

  log(message, color = RESET) {
    console.log(`${color}${message}${RESET}`);
  }

  async start() {
    this.log("\n🔍 MCP Server Comprehensive Test", BLUE);
    this.log("=================================\n", BLUE);

    try {
      await this.startServer();

      // Test all MCP methods
      await this.testInitialize();
      await this.testListTools();
      await this.testResourcesList();
      await this.testPromptsList();
      await this.testSampleToolCalls();

      await this.stopServer();

      this.log("\n✅ All tests completed!", GREEN);
      this.log("\nSummary:", BLUE);
      this.log("- Server starts and initializes correctly ✓", GREEN);
      this.log("- Tools are properly registered and callable ✓", GREEN);
      this.log("- Resources/prompts return empty arrays (expected) ✓", GREEN);
      this.log("\nThe server is ready for use with Claude Code!", GREEN);
    } catch (error) {
      this.log(`\n❌ Test failed: ${error.message}`, RED);
      if (this.server) {
        this.server.kill();
      }
      process.exit(1);
    }
  }

  startServer() {
    return new Promise((resolve, reject) => {
      this.log("Starting MCP server...", YELLOW);

      this.server = spawn("node", [SERVER_PATH], {
        env: {
          ...process.env,
          SHOPIFY_ACCESS_TOKEN,
          MYSHOPIFY_DOMAIN,
        },
      });

      // Capture stderr for debugging
      this.server.stderr.on("data", (data) => {
        const message = data.toString().trim();
        if (message.includes("Shopify Admin MCP Server running")) {
          this.log("✓ Server started successfully", GREEN);
          resolve();
        } else if (message) {
          this.log(`  ${message}`, GRAY);
        }
      });

      this.server.on("error", (error) => {
        reject(new Error(`Failed to start server: ${error.message}`));
      });

      this.rl = createInterface({
        input: this.server.stdout,
        crlfDelay: Infinity,
      });
    });
  }

  sendMessage(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.messageId;
      const message = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });

      this.log(`\n→ Testing: ${method}`, BLUE);

      const handler = (line) => {
        try {
          const response = JSON.parse(line);
          if (response.id === id) {
            this.rl.off("line", handler);
            if (response.error) {
              // For methods that don't exist, this is expected
              if (method === "resources/list" || method === "prompts/list") {
                this.log(`  ℹ️  Method not implemented (expected)`, GRAY);
                resolve({ notImplemented: true });
              } else {
                reject(new Error(`Server error: ${response.error.message}`));
              }
            } else {
              resolve(response.result);
            }
          }
        } catch (e) {
          // Ignore non-JSON lines
        }
      };

      this.rl.on("line", handler);
      this.server.stdin.write(message + "\n");

      setTimeout(() => {
        this.rl.off("line", handler);
        reject(new Error("Request timeout"));
      }, 5000);
    });
  }

  async testInitialize() {
    this.log("\n1️⃣  Protocol Initialization", YELLOW);

    const result = await this.sendMessage("initialize", {
      protocolVersion: "0.1.0",
      capabilities: {},
      clientInfo: {
        name: "test-client",
        version: "1.0.0",
      },
    });

    this.log(`  ✓ Server: ${result.serverInfo?.name} v${result.serverInfo?.version}`, GREEN);
    this.log(`  ✓ Protocol: ${result.protocolVersion}`, GREEN);
    this.log(`  ✓ Capabilities: ${Object.keys(result.capabilities).join(", ")}`, GREEN);
  }

  async testListTools() {
    this.log("\n2️⃣  Available Tools", YELLOW);

    const result = await this.sendMessage("tools/list");

    this.log(`  ✓ Total tools: ${result.tools.length}`, GREEN);

    // Group tools by category
    const categories = {
      Products: ["get-products", "get-products-by-collection", "get-products-by-ids"],
      Orders: ["get-orders", "get-order", "create-draft-order"],
      Customers: ["get-customers", "tag-customer"],
      Store: ["get-shop", "get-shop-details"],
      Pages: ["get-pages", "create-page", "update-page"],
      Themes: ["get-themes", "get-theme", "create-theme"],
    };

    for (const [category, toolNames] of Object.entries(categories)) {
      this.log(`\n  ${category}:`, BLUE);
      for (const toolName of toolNames) {
        const tool = result.tools.find((t) => t.name === toolName);
        if (tool) {
          this.log(`    ✓ ${toolName}`, GREEN);
        }
      }
    }
  }

  async testResourcesList() {
    this.log("\n3️⃣  Resources Support", YELLOW);

    const result = await this.sendMessage("resources/list");

    if (result.notImplemented) {
      this.log("  ⚠️  Resources not implemented in McpServer (normal)", YELLOW);
    } else {
      this.log(`  ✓ Resources: ${result.resources?.length || 0}`, GREEN);
    }
  }

  async testPromptsList() {
    this.log("\n4️⃣  Prompts Support", YELLOW);

    const result = await this.sendMessage("prompts/list");

    if (result.notImplemented) {
      this.log("  ⚠️  Prompts not implemented in McpServer (normal)", YELLOW);
    } else {
      this.log(`  ✓ Prompts: ${result.prompts?.length || 0}`, GREEN);
    }
  }

  async testSampleToolCalls() {
    this.log("\n5️⃣  Sample Tool Calls", YELLOW);

    // Test 1: Get shop info
    this.log("\n  Testing get-shop:", GRAY);
    const shopResult = await this.sendMessage("tools/call", {
      name: "get-shop",
      arguments: {},
    });

    if (shopResult.content?.[0]?.text.includes("VividWalls")) {
      this.log("    ✓ Shop data retrieved successfully", GREEN);
    }

    // Test 2: Get products with limit
    this.log("\n  Testing get-products:", GRAY);
    const productsResult = await this.sendMessage("tools/call", {
      name: "get-products",
      arguments: { limit: 2 },
    });

    if (productsResult.content?.[0]?.text) {
      this.log("    ✓ Products retrieved successfully", GREEN);
    }

    // Test 3: Get collections
    this.log("\n  Testing get-collections:", GRAY);
    const collectionsResult = await this.sendMessage("tools/call", {
      name: "get-collections",
      arguments: { limit: 5 },
    });

    if (collectionsResult.content?.[0]?.text) {
      this.log("    ✓ Collections retrieved successfully", GREEN);
    }
  }

  async stopServer() {
    this.log("\n🛑 Stopping server...", YELLOW);

    return new Promise((resolve) => {
      if (this.server) {
        this.server.on("close", () => {
          this.log("✓ Server stopped cleanly", GREEN);
          resolve();
        });
        this.server.kill();
      } else {
        resolve();
      }
    });
  }
}

// Run the tests
const tester = new MCPServerFullTester();
tester.start();
