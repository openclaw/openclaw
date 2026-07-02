#!/usr/bin/env node
/**
 * Real-behavior proof for connect error detail code trimming.
 *
 * Run from repo root:
 *   node --import tsx scripts/proof-connect-error-detail-code-trim.mjs
 */
import assert from "node:assert/strict";
import os from "node:os";
import process from "node:process";
import {
  ConnectErrorDetailCodes,
  formatConnectErrorMessage,
  readConnectErrorDetailCode,
  readPairingConnectErrorDetails,
} from "../packages/gateway-protocol/src/connect-error-details.ts";

function simulatePreFixReadConnectErrorDetailCode(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return null;
  }
  const code = details.code;
  return typeof code === "string" && code.trim().length > 0 ? code : null;
}

function padded(code) {
  return `  ${code}  `;
}

const cases = [
  {
    name: "PAIRING_REQUIRED",
    rawCode: padded(ConnectErrorDetailCodes.PAIRING_REQUIRED),
    details: {
      code: padded(ConnectErrorDetailCodes.PAIRING_REQUIRED),
      reason: "scope-upgrade",
      requestId: "req-proof-1",
    },
  },
  {
    name: "PROTOCOL_MISMATCH",
    rawCode: `\t${ConnectErrorDetailCodes.PROTOCOL_MISMATCH}\n`,
    details: {
      code: `\t${ConnectErrorDetailCodes.PROTOCOL_MISMATCH}\n`,
      clientMinProtocol: 5,
      clientMaxProtocol: 5,
      expectedProtocol: 4,
    },
  },
  {
    name: "CLIENT_VERSION_MISMATCH",
    rawCode: padded(ConnectErrorDetailCodes.CLIENT_VERSION_MISMATCH),
    details: {
      code: padded(ConnectErrorDetailCodes.CLIENT_VERSION_MISMATCH),
    },
  },
];

let passed = 0;
let failed = 0;

function pass(label) {
  passed += 1;
  console.log(`PASS  ${label}`);
}

function fail(label, detail) {
  failed += 1;
  console.error(`FAIL  ${label}`);
  if (detail) {
    console.error(`      ${detail}`);
  }
}

console.log("OpenClaw connect error detail code trim — real behavior proof");
console.log("-".repeat(72));
console.log(`Node:     ${process.version}`);
console.log(`Platform: ${process.platform} ${os.release()} (${os.arch()})`);
console.log(`CWD:      ${process.cwd()}`);
console.log("");

for (const testCase of cases) {
  const { name, rawCode, details } = testCase;
  const canonical = ConnectErrorDetailCodes[name];

  const preFix = simulatePreFixReadConnectErrorDetailCode({ code: rawCode });
  const postFix = readConnectErrorDetailCode({ code: rawCode });

  console.log(`Case: ${name}`);
  console.log(`  payload code: ${JSON.stringify(rawCode)}`);
  console.log(`  pre-fix readConnectErrorDetailCode:  ${JSON.stringify(preFix)}`);
  console.log(`  post-fix readConnectErrorDetailCode: ${JSON.stringify(postFix)}`);

  if (preFix === canonical) {
    fail(`${name} pre-fix unexpectedly matched canonical (proof setup)`);
  } else {
    pass(`${name} pre-fix does not match canonical (shows bug)`);
  }

  try {
    assert.equal(postFix, canonical);
    pass(`${name} post-fix returns trimmed canonical code`);
  } catch (error) {
    fail(`${name} post-fix trimmed code`, error.message);
  }

  if (name === "PAIRING_REQUIRED") {
    const pairing = readPairingConnectErrorDetails(details);
    const formatted = formatConnectErrorMessage({
      message: "pairing required",
      details,
    });
    const expectedMessage = "scope upgrade pending approval (requestId: req-proof-1)";

    if (
      pairing?.code === ConnectErrorDetailCodes.PAIRING_REQUIRED &&
      pairing.reason === "scope-upgrade"
    ) {
      pass(`${name} readPairingConnectErrorDetails accepts padded code`);
    } else {
      fail(`${name} readPairingConnectErrorDetails`, JSON.stringify(pairing));
    }

    if (formatted === expectedMessage) {
      pass(`${name} formatConnectErrorMessage uses structured pairing text`);
    } else {
      fail(`${name} formatConnectErrorMessage`, `got ${JSON.stringify(formatted)}`);
    }
  }

  if (name === "PROTOCOL_MISMATCH") {
    const formatted = formatConnectErrorMessage({
      message: "protocol mismatch",
      details,
    });
    const expected = "protocol mismatch: Control UI v5, Gateway v4";
    if (formatted === expected) {
      pass(`${name} formatConnectErrorMessage formats protocol mismatch`);
    } else {
      fail(`${name} formatConnectErrorMessage`, `got ${JSON.stringify(formatted)}`);
    }
  }

  if (name === "CLIENT_VERSION_MISMATCH") {
    const matchesCanonical =
      readConnectErrorDetailCode(details) === ConnectErrorDetailCodes.CLIENT_VERSION_MISMATCH;
    if (matchesCanonical) {
      pass(`${name} strict equality with ConnectErrorDetailCodes succeeds after trim`);
    } else {
      fail(`${name} strict equality with ConnectErrorDetailCodes`);
    }
  }

  console.log("");
}

console.log("-".repeat(72));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log("All proof checks passed.");
}
