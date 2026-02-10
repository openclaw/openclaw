import { wecomFetch } from "../src/http.js";

const args = process.argv.slice(2);
let proxyUrl = "";

if (args.includes("--host")) {
    const hostIndex = args.indexOf("--host");
    const portIndex = args.indexOf("--port");
    const userIndex = args.indexOf("--user");
    const passIndex = args.indexOf("--pass");

    if (hostIndex === -1 || portIndex === -1) {
        console.error("Error: --host and --port are required when using specific params.");
        process.exit(1);
    }

    const host = args[hostIndex + 1];
    const port = args[portIndex + 1];
    const user = userIndex !== -1 ? args[userIndex + 1] : "";
    const pass = passIndex !== -1 ? args[passIndex + 1] : "";

    if (user && pass) {
        // Safe encoding
        proxyUrl = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    } else {
        proxyUrl = `http://${host}:${port}`;
    }
} else {
    proxyUrl = args[0] || process.env.PROXY_URL || "";
}

if (!proxyUrl) {
  console.error("Usage: npx tsx extensions/wecom/scripts/test-proxy.ts <proxy_url>");
  console.error("   OR: npx tsx extensions/wecom/scripts/test-proxy.ts --host <ip> --port <port> --user <u?> --pass <p?>");
  process.exit(1);
}

console.log(`Testing proxy: ${proxyUrl.replace(/:([^:@]+)@/, ":***@")}`); // Mask password in log

async function run() {
  try {
    // 1. Test IP echo to verify traffic goes through proxy
    console.log("1. Checking IP via httpbin.org...");
    const ipRes = await wecomFetch("https://httpbin.org/ip", {}, { proxyUrl, timeoutMs: 10000 });
    if (!ipRes.ok) {
        throw new Error(`IP check failed: ${ipRes.status} ${ipRes.statusText}`);
    }
    const ipJson = await ipRes.json();
    console.log("   Result:", ipJson);

    // 2. Test WeCom API connectivity
    console.log("2. Checking WeCom connectivity...");
    const wecomRes = await wecomFetch("https://qyapi.weixin.qq.com/cgi-bin/gettoken", {}, { proxyUrl, timeoutMs: 10000 });
    const wecomJson = await wecomRes.json();
    console.log("   Result:", wecomJson);
    console.log("✅ Proxy works!");

  } catch (err) {
    // Extract cause for better debugging
    const cause = (err as any).cause;
    if (cause) {
        console.error("❌ Proxy test failed (Cause):", cause);
    } else {
        console.error("❌ Proxy test failed:", err);
    }
    process.exit(1);
  }
}

run();
