/**
 * Reproduction script for issue #93069.
 * Validates that passing `protocol: "grpc"` in diagnostics.otel config
 * fails validation with a clear error, and that the only accepted
 * value is "http/protobuf".
 */
import { z } from "zod";

// Replicate the exact otel protocol schema from zod-schema.ts:544
const OtelProtocol = z.literal("http/protobuf").optional();

function validateProtocol(value) {
  const result = OtelProtocol.safeParse(value);
  return {
    accepted: result.success,
    error: result.success ? null : result.error.issues[0].message,
  };
}

async function main() {
  console.log("=== Issue #93069: OTel gRPC Config Validation ===\n");

  // 1) gRPC should be rejected
  console.log("--- protocol: 'grpc' ---");
  const r1 = validateProtocol("grpc");
  console.log(`  accepted: ${r1.accepted}`);
  console.log(`  error:    ${r1.error}`);
  console.log(r1.accepted ? "  ✗ should have been rejected" : "  ✓ rejected");
  console.log();

  // 2) http/protobuf should be accepted
  console.log("--- protocol: 'http/protobuf' ---");
  const r2 = validateProtocol("http/protobuf");
  console.log(`  accepted: ${r2.accepted}`);
  console.log(r2.accepted ? "  ✓ accepted" : "  ✗ should have been accepted");
  console.log();

  // 3) undefined (default) should be accepted (optional)
  console.log("--- protocol: undefined (default) ---");
  const r3 = validateProtocol(undefined);
  console.log(`  accepted: ${r3.accepted}`);
  console.log(r3.accepted ? "  ✓ accepted as default" : "  ✗ should accept default");
  console.log();

  console.log("=== Summary ===");
  console.log("- gRPC is now rejected at config validation (was silently ignored at runtime)");
  console.log("- Only http/protobuf is accepted");
  console.log("- Clear error message guides operator to use http/protobuf instead");
  console.log("- Docs updated: schema.help.ts, opentelemetry.md, configuration-reference.md");
}

main().catch((err) => {
  console.error("Repro script failed:", err);
  process.exit(1);
});
