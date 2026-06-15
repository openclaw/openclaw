import { scanEmptyAllowlistPolicyWarnings } from "./src/commands/doctor/shared/empty-allowlist-scan.js";

console.log("=== Test 1: All accounts override parent groupAllowFrom (no false warning) ===");
const result1 = scanEmptyAllowlistPolicyWarnings(
  {
    channels: {
      signal: {
        dmPolicy: "open",
        groupPolicy: "allowlist",
        accounts: {
          work: { groupPolicy: "allowlist", groupAllowFrom: ["+1234567890"] },
          personal: { groupPolicy: "allowlist", groupAllowFrom: ["+1987654321"] },
        },
      },
    },
  },
  { doctorFixCommand: "openclaw doctor --fix" },
);
console.log("Warnings:", JSON.stringify(result1));
console.log("No false warning:", result1.length === 0 ? "PASS" : "FAIL");

console.log("\n=== Test 2: Some accounts lack groupAllowFrom (should still warn) ===");
const result2 = scanEmptyAllowlistPolicyWarnings(
  {
    channels: {
      signal: {
        groupPolicy: "allowlist",
        accounts: {
          work: { groupPolicy: "allowlist", groupAllowFrom: ["+1234567890"] },
          personal: { groupPolicy: "allowlist" },
        },
      },
    },
  },
  { doctorFixCommand: "openclaw doctor --fix" },
);
console.log("Warnings:", JSON.stringify(result2));
console.log("Has parent warning:", result2.some(w => w.includes("channels.signal.groupPolicy")) ? "PASS" : "FAIL");

console.log("\n=== Test 3: DM policy warnings preserved ===");
const result3 = scanEmptyAllowlistPolicyWarnings(
  {
    channels: {
      signal: {
        dmPolicy: "allowlist",
        groupPolicy: "allowlist",
        accounts: {
          work: { groupPolicy: "allowlist", groupAllowFrom: ["+1234567890"] },
        },
      },
    },
  },
  { doctorFixCommand: "openclaw doctor --fix" },
);
console.log("Warnings:", JSON.stringify(result3));
console.log("DM warning preserved:", result3.some(w => w.includes("dmPolicy")) ? "PASS" : "FAIL");

console.log("\n=== Test 4: Accounts with allowFrom on fallback-capable channel (no false warning) ===");
const result4 = scanEmptyAllowlistPolicyWarnings(
  {
    channels: {
      signal: {
        dmPolicy: "open",
        groupPolicy: "allowlist",
        accounts: {
          work: { groupPolicy: "allowlist", allowFrom: ["+1234567890"] },
          personal: { groupPolicy: "allowlist", allowFrom: ["+1987654321"] },
        },
      },
    },
  },
  { doctorFixCommand: "openclaw doctor --fix" },
);
console.log("Warnings:", JSON.stringify(result4));
console.log("No false warning:", result4.length === 0 ? "PASS" : "FAIL");

console.log("\n=== Test 5: Disabled account without allowFrom does not trigger parent warning ===");
const result5 = scanEmptyAllowlistPolicyWarnings(
  {
    channels: {
      signal: {
        dmPolicy: "open",
        groupPolicy: "allowlist",
        accounts: {
          work: { groupPolicy: "allowlist", groupAllowFrom: ["+1234567890"] },
          personal: { enabled: false, groupPolicy: "allowlist" },
        },
      },
    },
  },
  { doctorFixCommand: "openclaw doctor --fix" },
);
console.log("Warnings:", JSON.stringify(result5));
console.log("No false warning:", result5.length === 0 ? "PASS" : "FAIL");
