#!/usr/bin/env node
/**
 * auth-proxy — Reverse proxy for web auth with cookie capture.
 *
 * Proxies a target login page through a local HTTP server.
 * User sees native HTML (mobile-friendly, real keyboard, copy-paste).
 * Captures Set-Cookie headers from the target after login.
 *
 * Usage: node auth-proxy.cjs <target-url> [--port 7890] [--extract-cookies domain1,domain2] [--output cookies.json]
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

// --- Parse args ---
const args = process.argv.slice(2);
let targetUrl = null;
let port = 7890;
let extractDomains = [];
let outputFile = "cookies.json";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port") { port = parseInt(args[++i]); }
  else if (args[i] === "--extract-cookies") { extractDomains = args[++i].split(",").map(d => d.trim()); }
  else if (args[i] === "--output") { outputFile = args[++i]; }
  else if (args[i] === "-h" || args[i] === "--help") {
    console.log("Usage: auth-proxy.cjs <target-url> [--port 7890] [--extract-cookies d1,d2] [--output cookies.json]");
    process.exit(0);
  }
  else if (!args[i].startsWith("-")) { targetUrl = args[i]; }
}

if (!targetUrl) {
  console.error("Error: target URL required");
  process.exit(1);
}

const target = new URL(targetUrl);
const targetOrigin = target.origin;
const isTargetHttps = target.protocol === "https:";
const httpModule = isTargetHttps ? https : http;

// Collected cookies from all responses
const capturedCookies = new Map(); // name -> full cookie object

function parseCookieHeader(setCookieHeader, requestHost) {
  // Parse a Set-Cookie header string into a structured object
  const parts = setCookieHeader.split(";").map(p => p.trim());
  const [nameValue, ...attrs] = parts;
  const eqIdx = nameValue.indexOf("=");
  if (eqIdx === -1) return null;

  const cookie = {
    name: nameValue.substring(0, eqIdx),
    value: nameValue.substring(eqIdx + 1),
    domain: requestHost,
    path: "/",
    raw: setCookieHeader,
  };

  for (const attr of attrs) {
    const [key, ...valParts] = attr.split("=");
    const k = key.toLowerCase().trim();
    const v = valParts.join("=").trim();
    if (k === "domain") cookie.domain = v;
    else if (k === "path") cookie.path = v;
    else if (k === "expires") cookie.expires = v;
    else if (k === "max-age") cookie.maxAge = parseInt(v);
    else if (k === "httponly") cookie.httpOnly = true;
    else if (k === "secure") cookie.secure = true;
    else if (k === "samesite") cookie.sameSite = v;
  }

  return cookie;
}

// Build cookie jar string from captured cookies for forwarding
function getCookieJar() {
  return Array.from(capturedCookies.values())
    .map(c => `${c.name}=${c.value}`)
    .join("; ");
}

function rewriteHeaders(headers, proxyHost) {
  const result = { ...headers };

  // Remove hop-by-hop headers
  delete result["host"];
  delete result["connection"];
  delete result["keep-alive"];
  delete result["transfer-encoding"];
  delete result["upgrade"];

  // Set correct host for target
  result["host"] = target.host;

  // Forward cookies from our jar
  const jar = getCookieJar();
  if (jar) {
    result["cookie"] = jar;
  }

  // Remove referer/origin that would expose the proxy
  if (result["referer"]) {
    result["referer"] = result["referer"].replace(new RegExp(`https?://[^/]+`, "g"), targetOrigin);
  }
  if (result["origin"]) {
    result["origin"] = targetOrigin;
  }

  return result;
}

function rewriteLocationHeader(location, proxyHost) {
  if (!location) return location;
  try {
    const locUrl = new URL(location, targetOrigin);
    if (locUrl.origin === targetOrigin) {
      return `http://${proxyHost}${locUrl.pathname}${locUrl.search}${locUrl.hash}`;
    }
  } catch {}
  return location;
}

function rewriteBody(body, contentType, proxyHost) {
  if (!contentType) return body;
  const ct = contentType.toLowerCase();
  if (!ct.includes("text/html") && !ct.includes("text/css") && !ct.includes("javascript")) {
    return body;
  }

  let text = body.toString("utf-8");

  // Rewrite absolute URLs to target → proxy
  const escapedOrigin = targetOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  text = text.replace(new RegExp(escapedOrigin, "g"), `http://${proxyHost}`);

  // Also handle protocol-relative URLs
  const protoRelative = targetOrigin.replace(/^https?:/, "");
  text = text.replace(new RegExp(protoRelative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), "g"), `//${proxyHost}`);

  return Buffer.from(text, "utf-8");
}

// Status page
function statusPage(proxyHost) {
  const cookieCount = capturedCookies.size;
  const cookieList = Array.from(capturedCookies.values())
    .map(c => `  • ${c.name} (${c.domain})`)
    .join("\n");

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Auth Proxy Status</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; }
  .btn { display: inline-block; padding: 12px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-size: 16px; margin: 8px 4px; }
  .btn.done { background: #16a34a; }
  pre { background: #f3f4f6; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
  .cookie-count { font-size: 48px; font-weight: bold; color: ${cookieCount > 0 ? '#16a34a' : '#9ca3af'}; }
</style>
</head><body>
<h1>🔐 Auth Proxy</h1>
<p>Target: <strong>${targetOrigin}</strong></p>
<p class="cookie-count">${cookieCount} cookies captured</p>
${cookieList ? `<pre>${cookieList}</pre>` : '<p>No cookies yet. Log in first!</p>'}
<a class="btn" href="/">→ Go to login page</a>
${cookieCount > 0 ? '<a class="btn done" href="/__auth_proxy__/done">✅ Done — save cookies</a>' : ''}
</body></html>`;
}

const server = http.createServer((req, res) => {
  const proxyHost = req.headers.host || `localhost:${port}`;

  // Status/control endpoints
  if (req.url === "/__auth_proxy__/status") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(statusPage(proxyHost));
    return;
  }

  if (req.url === "/__auth_proxy__/cookies") {
    const cookies = Array.from(capturedCookies.values());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(cookies, null, 2));
    return;
  }

  if (req.url === "/__auth_proxy__/done") {
    const cookies = Array.from(capturedCookies.values());
    if (outputFile) {
      fs.writeFileSync(outputFile, JSON.stringify(cookies, null, 2) + "\n");
      console.log(`\n✅ Saved ${cookies.length} cookies → ${outputFile}`);
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><head>
      <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body{font-family:-apple-system,system-ui,sans-serif;max-width:600px;margin:40px auto;padding:0 20px;text-align:center;}</style>
      </head><body>
      <h1>✅ Done!</h1>
      <p>${cookies.length} cookies saved.</p>
      <p>You can close this tab now.</p>
      </body></html>`);

    // Signal to parent process
    console.log("__AUTH_PROXY_DONE__");
    setTimeout(() => process.exit(0), 1000);
    return;
  }

  // Proxy the request
  const targetPath = req.url || "/";
  const headers = rewriteHeaders(req.headers, proxyHost);

  // Remove accept-encoding to get uncompressed response (easier to rewrite)
  delete headers["accept-encoding"];

  const proxyReq = httpModule.request(
    {
      hostname: target.hostname,
      port: target.port || (isTargetHttps ? 443 : 80),
      path: targetPath,
      method: req.method,
      headers: headers,
      rejectUnauthorized: true,
    },
    (proxyRes) => {
      // Capture Set-Cookie headers
      const setCookies = proxyRes.headers["set-cookie"] || [];
      for (const sc of setCookies) {
        const parsed = parseCookieHeader(sc, target.hostname);
        if (parsed) {
          capturedCookies.set(parsed.name, parsed);
          if (extractDomains.length === 0 || extractDomains.some(d => parsed.domain.includes(d))) {
            console.log(`  🍪 ${parsed.name}=${parsed.value.substring(0, 20)}...`);
          }
        }
      }

      // Collect response body for rewriting
      const chunks = [];
      proxyRes.on("data", (chunk) => chunks.push(chunk));
      proxyRes.on("end", () => {
        let body = Buffer.concat(chunks);
        const contentType = proxyRes.headers["content-type"] || "";

        // Rewrite body (URLs)
        body = rewriteBody(body, contentType, proxyHost);

        // Rewrite response headers
        const resHeaders = { ...proxyRes.headers };

        // Rewrite Location headers for redirects
        if (resHeaders["location"]) {
          resHeaders["location"] = rewriteLocationHeader(resHeaders["location"], proxyHost);
        }

        // Rewrite Set-Cookie domains to work with proxy
        if (resHeaders["set-cookie"]) {
          resHeaders["set-cookie"] = resHeaders["set-cookie"].map(sc => {
            // Remove Domain attribute so cookie applies to proxy host
            return sc
              .replace(/;\s*[Dd]omain=[^;]*/g, "")
              .replace(/;\s*[Ss]ecure/g, "")
              .replace(/;\s*[Ss]ame[Ss]ite=[^;]*/g, "; SameSite=Lax");
          });
        }

        // Remove CSP that might block our proxy
        delete resHeaders["content-security-policy"];
        delete resHeaders["content-security-policy-report-only"];
        delete resHeaders["x-frame-options"];

        // Fix content-length since we might have rewritten the body
        resHeaders["content-length"] = Buffer.byteLength(body);

        // Remove transfer-encoding since we're sending the full body
        delete resHeaders["transfer-encoding"];

        res.writeHead(proxyRes.statusCode, resHeaders);
        res.end(body);
      });
    }
  );

  proxyReq.on("error", (err) => {
    console.error(`  ❌ Proxy error: ${err.message}`);
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`Proxy error: ${err.message}`);
  });

  // Forward request body
  req.pipe(proxyReq);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`\n🔐 Auth Proxy running on http://127.0.0.1:${port}`);
  console.log(`   Proxying → ${targetOrigin}`);
  console.log(`   Status:  http://127.0.0.1:${port}/__auth_proxy__/status`);
  console.log(`\n   After login, visit /__auth_proxy__/status to check cookies`);
  console.log(`   Then hit /__auth_proxy__/done to save and exit\n`);
});

process.on("SIGINT", () => {
  console.log("\n🧹 Shutting down...");
  server.close();
  process.exit(0);
});
