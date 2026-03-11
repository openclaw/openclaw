#!/usr/bin/env node
/**
 * Extract cookies from a running Chrome instance via CDP.
 *
 * Usage: node extract-cookies.cjs <cdp-port> <domains> [output-file]
 *   domains: comma-separated list (e.g., "amazon.com,jefit.com")
 *   output-file: defaults to stdout
 */

const http = require("http");
const { WebSocket } = require("ws");
const fs = require("fs");

const [cdpPort, domainsArg, outputFile] = process.argv.slice(2);

if (!cdpPort || !domainsArg) {
  console.error("Usage: extract-cookies.cjs <cdp-port> <domains> [output-file]");
  process.exit(1);
}

const domains = domainsArg.split(",").map((d) => d.trim().toLowerCase());

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { family: 4 }, (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve(JSON.parse(data)));
      })
      .on("error", reject);
  });
}

async function getCookies() {
  const targets = await httpGet(`http://localhost:${cdpPort}/json`);
  const wsUrl = targets[0] && targets[0].webSocketDebuggerUrl;
  if (!wsUrl) {
    throw new Error("No debugger target found");
  }

  // Force IPv4 to match Chrome's --remote-debugging-address=127.0.0.1
  const wsUrlIpv4 = wsUrl.replace("localhost", "127.0.0.1");
  const ws = new WebSocket(wsUrlIpv4);
  await new Promise((r) => ws.on("open", r));

  ws.send(JSON.stringify({ id: 1, method: "Network.getAllCookies" }));

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("CDP timeout")), 5000);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === 1) {
        clearTimeout(timeout);
        resolve(msg.result);
      }
    });
  });

  ws.close();

  const filtered = result.cookies.filter((c) =>
    domains.some((d) => c.domain.toLowerCase().includes(d))
  );

  return filtered;
}

getCookies()
  .then((cookies) => {
    const json = JSON.stringify(cookies, null, 2);
    if (outputFile) {
      fs.writeFileSync(outputFile, json + "\n");
      console.error(`✅ Extracted ${cookies.length} cookies → ${outputFile}`);
    } else {
      console.log(json);
    }
  })
  .catch((err) => {
    console.error(`❌ Cookie extraction failed: ${err.message}`);
    process.exit(1);
  });
