#!/usr/bin/env node

import { spawn } from "child_process";
import { createInterface } from "readline";

// Colors for output
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";

// Test configuration
const SERVER_PATH = "./build/index.js";
const SHOPIFY_ACCESS_TOKEN = "shpat_EXAMPLE_REPLACE_WITH_YOUR_TOKEN";
const MYSHOPIFY_DOMAIN = "vividwalls-2.myshopify.com";

class MCPServerTester {
  constructor() {
    this.server = null;
    this.messageId = 0;
  }

  log(message, color = RESET) {
    console.log(`${color}${message}${RESET}`);
  }

  async start() {
    this.log("\n🚀 Starting MCP Server Test Suite", BLUE);
    this.log("================================\n", BLUE);

    try {
      // Start the server
      await this.startServer();

      // Run tests
      await this.testInitialize();
      await this.testListTools();
      await this.testToolCall();

      // Clean up
      await this.stopServer();

      this.log("\n✅ All tests passed!", GREEN);
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

      this.server.stderr.once("data", (data) => {
        const message = data.toString();
        if (message.includes("Shopify Admin MCP Server running")) {
          this.log("✓ Server started successfully", GREEN);
          resolve();
        } else {
          reject(new Error(`Server startup error: ${message}`));
        }
      });

      this.server.on("error", (error) => {
        reject(new Error(`Failed to start server: ${error.message}`));
      });

      // Set up readline interface for communication
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

      this.log(`\n→ Sending: ${method}`, BLUE);

      const handler = (line) => {
        try {
          const response = JSON.parse(line);
          if (response.id === id) {
            this.rl.off("line", handler);
            if (response.error) {
              reject(new Error(`Server error: ${response.error.message}`));
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

      // Timeout after 5 seconds
      setTimeout(() => {
        this.rl.off("line", handler);
        reject(new Error("Request timeout"));
      }, 5000);
    });
  }

  async testInitialize() {
    this.log("\nTest 1: Initialize Protocol", YELLOW);

    const result = await this.sendMessage("initialize", {
      protocolVersion: "0.1.0",
      capabilities: {},
      clientInfo: {
        name: "test-client",
        version: "1.0.0",
      },
    });

    if (result.serverInfo?.name === "shopify-admin-tools") {
      this.log("✓ Server info correct", GREEN);
      this.log(`  Name: ${result.serverInfo.name}`, RESET);
      this.log(`  Version: ${result.serverInfo.version}`, RESET);
    } else {
      throw new Error("Invalid server info");
    }

    if (result.capabilities?.tools) {
      this.log("✓ Tools capability present", GREEN);
    } else {
      throw new Error("Tools capability missing");
    }
  }

  async testListTools() {
    this.log("\nTest 2: List Available Tools", YELLOW);

    const result = await this.sendMessage("tools/list");

    if (!Array.isArray(result.tools)) {
      throw new Error("Tools list not returned");
    }

    this.log(`✓ Found ${result.tools.length} tools`, GREEN);

    // Check for some expected tools
    const expectedTools = ["get-shop", "get-products", "get-orders"];
    for (const toolName of expectedTools) {
      const tool = result.tools.find((t) => t.name === toolName);
      if (tool) {
        this.log(`  ✓ ${toolName}: ${tool.description}`, GREEN);
      } else {
        throw new Error(`Expected tool '${toolName}' not found`);
      }
    }
  }

  async testToolCall() {
    this.log("\nTest 3: Call get-shop Tool", YELLOW);

    const result = await this.sendMessage("tools/call", {
      name: "get-shop",
      arguments: {},
    });

    if (result.content && result.content.length > 0) {
      this.log("✓ Shop data retrieved", GREEN);
      const shopData = result.content[0].text;
      if (shopData.includes("vividwalls")) {
        this.log("  ✓ Correct shop domain", GREEN);
      }
    } else {
      throw new Error("No shop data returned");
    }
  }

  async stopServer() {
    this.log("\nStopping server...", YELLOW);

    return new Promise((resolve) => {
      if (this.server) {
        this.server.on("close", () => {
          this.log("✓ Server stopped", GREEN);
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
const tester = new MCPServerTester();
tester.start();
