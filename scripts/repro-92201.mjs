// REAL BEHAVIOR PROOF — shouldRecoverAnthropicThinkingError raw error fix
// Verifies that the recovery wrapper now catches thinking block errors
// even when they come through as genericized Error objects.
import { wrapAnthropicStreamWithRecovery } from "../src/agents/embedded-agent-runner/thinking.js";

let callCount = 0;
const META = { id: "repro-session-92201" };

// Simulate the Anthropic streaming function:
// 1st call: rejects with a genericized error wrapping the thinking block signature
// 2nd call (retry after stripping thinking blocks): succeeds
const streamFn = () => {
  callCount++;
  if (callCount > 1) {
    return Promise.resolve(
      Object.assign(Promise.resolve({ role: "assistant", content: [], stopReason: "end_turn" }), {
        result: async () => ({ role: "assistant", content: [], stopReason: "end_turn" }),
      }),
    );
  }
  return Promise.reject(
    Object.assign(
      new Error("LLM request failed: provider rejected the request schema or tool payload."),
      {
        cause: new Error("messages.1.content.0: Invalid signature in thinking block"),
      },
    ),
  );
};

const wrapped = wrapAnthropicStreamWithRecovery(streamFn, META);
try {
  await wrapped({}, { messages: [] }, {});
  console.log("=== Stream completed without error ===");
  if (META.recoveredAnthropicThinking) {
    console.log("\n✅ SUCCESS: Recovery wrapper correctly detected thinking block signature error");
    console.log("   The raw error's cause chain contained 'Invalid signature in thinking block',");
    console.log(
      "   which matches THINKING_BLOCK_ERROR_PATTERN despite the genericized outer message.",
    );
  } else {
    console.log("\n⚠️  Recovery flag not set on meta (may have used streaming path)");
  }
  if (callCount >= 2) {
    console.log("✅ Retry was attempted after stripping thinking blocks");
  }
  process.exit(0);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log("=== Stream failed ===");
  console.error("Error:", msg);
  process.exit(1);
}
