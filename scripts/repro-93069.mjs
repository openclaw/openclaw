import { OpenClawSchema } from "../src/config/zod-schema.js";

console.log("=== Validation test: diagnostics.otel.protocol ===");
console.log();

console.log("--- Test 1: protocol 'http/protobuf' (expected: pass) ---");
const r1 = OpenClawSchema.safeParse({ diagnostics: { otel: { protocol: "http/protobuf" } } });
console.log("  valid:", r1.success);
console.log();

console.log("--- Test 2: protocol 'grpc' (expected: fail) ---");
const r2 = OpenClawSchema.safeParse({ diagnostics: { otel: { protocol: "grpc" } } });
console.log("  valid:", r2.success);
if (!r2.success) console.log("  error:", r2.error.issues.map((i) => i.message).join("; "));
console.log();

console.log("--- Test 3: no protocol (expected: pass) ---");
const r3 = OpenClawSchema.safeParse({ diagnostics: { otel: {} } });
console.log("  valid:", r3.success);
console.log();

console.log("=== Summary ===");
console.log("Before: 'grpc' silently accepted, OTel disabled at runtime");
console.log("After:  'grpc' rejected at config validation with clear error");
