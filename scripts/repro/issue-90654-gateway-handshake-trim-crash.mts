import { formatAuditList } from "../../src/gateway/server/ws-connection/message-handler.js";

// Reproduction for issue #90654
// Demonstrates that formatAuditList must skip non-string items instead of
// crashing with "Cannot read properties of undefined (reading 'trim')".

function main() {
  console.log("=== Reproduction for issue #90654 ===");

  // Valid cases
  console.log("\nValid cases:");
  console.log("  undefined:", formatAuditList(undefined));
  console.log("  empty:", formatAuditList([]));
  console.log("  normal:", formatAuditList(["  b  ", "a", "c "]));

  // Before fix: this would crash with TypeError
  const malformed = ["valid", undefined, null, 42, "also-valid"] as unknown as string[];

  console.log("\nMalformed input (contains non-string items):");
  console.log("  Input:", malformed);

  let result: string;
  try {
    result = formatAuditList(malformed);
    console.log("  Result:", result);
  } catch (err) {
    console.error("FAIL: formatAuditList threw on non-string items:");
    console.error(err);
    process.exitCode = 1;
    return;
  }

  const expected = "also-valid,valid";
  if (result === expected) {
    console.log("\nPASS: Non-string items are safely skipped.");
  } else {
    console.error(`\nFAIL: Expected "${expected}", got "${result}".`);
    process.exitCode = 1;
  }
}

main();
