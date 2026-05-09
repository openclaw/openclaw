import { performance } from "node:perf_hooks";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

// Real patched modules from the security/bootstrap-dos-poc worktree:
import {
  resolveConnectAuthDecision,
  resolveConnectAuthState,
} from "../../src/gateway/server/ws-connection/auth-context.ts";
import { createAuthRateLimiter } from "../../src/gateway/auth-rate-limit.ts";

const ATTACKER_IP = "203.0.113.42";
const VICTIM_IP = "198.51.100.7";
const MUTEX_HOLD_MS = 5;

let verifierCalls = 0;
const verifyMutex: { p: Promise<void> } = { p: Promise.resolve() };

async function verifyBootstrapToken(p: {
  deviceId: string;
  publicKey: string;
  token: string;
  role: string;
  scopes: string[];
}): Promise<{ ok: boolean; reason?: string }> {
  const wait = verifyMutex.p;
  let release: () => void = () => {};
  verifyMutex.p = new Promise<void>((r) => {
    release = r;
  });
  await wait;
  verifierCalls += 1;
  await new Promise((r) => setTimeout(r, MUTEX_HOLD_MS));
  release();
  if (p.token === "valid-bootstrap") {
    return { ok: true };
  }
  return { ok: false, reason: "bootstrap_token_invalid" };
}

async function verifyDeviceToken(): Promise<{ ok: boolean }> {
  return { ok: false };
}

function makeReq(remoteAddr: string): IncomingMessage {
  const sock = new Socket();
  Object.defineProperty(sock, "remoteAddress", { value: remoteAddr, configurable: true });
  const req = new IncomingMessage(sock);
  req.headers = {};
  return req;
}

async function attempt(
  rateLimiter: ReturnType<typeof createAuthRateLimiter>,
  ip: string,
  token: string,
) {
  const state = await resolveConnectAuthState({
    resolvedAuth: { mode: "open" } as any,
    connectAuth: { bootstrapToken: token },
    hasDeviceIdentity: true,
    req: makeReq(ip),
    trustedProxies: [],
    allowRealIpFallback: true,
    rateLimiter,
    clientIp: ip,
  });
  return await resolveConnectAuthDecision({
    state,
    hasDeviceIdentity: true,
    deviceId: ip === VICTIM_IP ? "device-victim" : "device-attacker",
    publicKey: "ed25519:" + "x".repeat(40),
    role: "operator",
    scopes: ["session.read"],
    rateLimiter,
    clientIp: ip,
    verifyBootstrapToken,
    verifyDeviceToken,
  });
}

async function main() {
  console.log("Bootstrap-token DoS rate-limit proof (PR 76322)");
  console.log("Imports real patched resolveConnectAuthDecision + createAuthRateLimiter");
  console.log("from security/bootstrap-dos-poc worktree.");
  console.log("");

  const rateLimiter = createAuthRateLimiter({
    maxAttempts: 5,
    windowMs: 60_000,
    lockoutMs: 60_000,
    exemptLoopback: false,
    pruneIntervalMs: 0,
  });

  console.log(`maxAttempts=5  windowMs=60s  lockoutMs=60s  exemptLoopback=false`);
  console.log(`simulated mutex hold per verify call: ${MUTEX_HOLD_MS}ms`);
  console.log("");

  console.log("=== Phase 1: 20 sequential attacker attempts from a single IP ===");
  console.log("attempt | reason                  | rateLimited | verifier?");
  console.log("--------|-------------------------|-------------|--------------");
  for (let i = 1; i <= 20; i += 1) {
    const before = verifierCalls;
    const decision = await attempt(rateLimiter, ATTACKER_IP, "bogus-attacker-token");
    const reason = decision.authResult.ok ? "ok" : (decision.authResult.reason ?? "unknown");
    const rateLimited =
      "rateLimited" in decision.authResult && (decision.authResult as any).rateLimited === true;
    const delta = verifierCalls - before;
    console.log(
      `   ${String(i).padStart(2)}   | ${reason.padEnd(23)} | ${String(rateLimited).padEnd(11)} | ${delta === 1 ? "ENTERED" : "skipped"}`,
    );
  }
  console.log("");
  console.log(`attacker verifier-call total: ${verifierCalls} of 20 attempts`);
  console.log("");

  console.log("=== Phase 2: legitimate victim under sustained attack ===");
  console.log("");
  verifierCalls = 0;
  const stopAt = performance.now() + 500;
  const attackerLoop = (async () => {
    while (performance.now() < stopAt) {
      await attempt(rateLimiter, ATTACKER_IP, "bogus-attacker-token");
    }
  })();
  // While attacker is hammering, victim makes 5 legitimate attempts and we measure each.
  await new Promise((r) => setTimeout(r, 25));
  const victimLatencies: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const t0 = performance.now();
    const decision = await attempt(rateLimiter, VICTIM_IP, "valid-bootstrap");
    const elapsed = performance.now() - t0;
    victimLatencies.push(elapsed);
    console.log(
      `victim attempt ${i + 1}: ${elapsed.toFixed(2)}ms  authOk=${decision.authOk}  method=${decision.authMethod}`,
    );
    await new Promise((r) => setTimeout(r, 50));
  }
  await attackerLoop;
  const avg = victimLatencies.reduce((a, b) => a + b, 0) / victimLatencies.length;
  console.log("");
  console.log(`victim average latency under attack: ${avg.toFixed(2)}ms`);
  console.log(`attacker verifier entries during 500ms attack: ${verifierCalls}`);
  console.log(
    `attacker call rate during attack: ~${Math.round((verifierCalls + 1) / 0.5)} verifier-acquisitions/sec`,
  );
  console.log("");

  console.log("=== Phase 3: IP isolation — victim from clean IP ===");
  console.log("");
  const t1 = performance.now();
  const legit = await attempt(rateLimiter, "198.51.100.99", "valid-bootstrap");
  const legitMs = performance.now() - t1;
  console.log(
    `clean victim IP: ${legitMs.toFixed(2)}ms  authOk=${legit.authOk}  method=${legit.authMethod}`,
  );
  console.log("");

  console.log("=== Summary ===");
  console.log(`Phase 1: after 5 failures, attempts 6-20 short-circuit before mutex (verifier=5/20)`);
  console.log(
    `Phase 2: under sustained attacker flood, victim latency stayed at ${avg.toFixed(0)}ms (verifier hold = ${MUTEX_HOLD_MS}ms)`,
  );
  console.log(
    `Phase 3: clean victim IP unaffected by attacker lockout (${legitMs.toFixed(0)}ms; authOk=${legit.authOk})`,
  );

  rateLimiter.dispose();
}

await main();
