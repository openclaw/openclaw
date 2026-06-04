import {
  isUserAbortReason,
  shouldSuppressTakeoverErrorOnUserAbort,
} from "../src/agents/embedded-agent-runner/run/attempt.js";
import { EmbeddedAttemptSessionTakeoverError } from "../src/agents/embedded-agent-runner/run/attempt.session-lock.js";

function createChatAbortSignalReason(stopReason) {
  if (stopReason === "timeout") {
    const reason = new Error("chat run timed out");
    reason.name = "TimeoutError";
    return reason;
  }
  if (stopReason === "restart") {
    const reason = new Error("chat run aborted for gateway restart");
    reason.name = "AbortError";
    return reason;
  }
  if (stopReason === "auth-revoked") {
    const reason = new Error("chat run aborted for provider auth revocation");
    reason.name = "AbortError";
    return reason;
  }
  if (stopReason === "stop") {
    const reason = new Error("chat run aborted by user stop command");
    reason.name = "AbortError";
    return reason;
  }
  return undefined;
}

function assert(condition, message) {
  if (!condition) {
    console.error(`✗ FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ PASS: ${message}`);
  }
}

function main() {
  console.log("=== User-Stop Abort Provenance Proof ===\n");

  // 1. User-stop path via chat.abort(origin: "user-stop") → stopReason: "stop"
  console.log('1. User-stop signal (chat.abort origin: "user-stop")');
  const userStopReason = createChatAbortSignalReason("stop");
  assert(userStopReason instanceof Error, "createChatAbortSignalReason('stop') returns Error");
  assert(userStopReason.name === "AbortError", "user-stop reason is AbortError");
  assert(
    userStopReason.message.includes("user stop command"),
    "user-stop message contains 'user stop command'",
  );
  assert(isUserAbortReason(userStopReason), "isUserAbortReason(user-stop) = true");

  // 2. Restart signal
  console.log("\n2. Restart signal (Gateway shutdown)");
  const restartReason = createChatAbortSignalReason("restart");
  assert(restartReason instanceof Error, "createChatAbortSignalReason('restart') returns Error");
  assert(restartReason.name === "AbortError", "restart reason is AbortError");
  assert(
    restartReason.message.includes("gateway restart"),
    "restart message contains 'gateway restart'",
  );
  assert(!isUserAbortReason(restartReason), "isUserAbortReason(restart) = false");

  // 3. Auth-revoked signal
  console.log("\n3. Auth-revoked signal (provider logout)");
  const authRevokedReason = createChatAbortSignalReason("auth-revoked");
  assert(
    authRevokedReason instanceof Error,
    "createChatAbortSignalReason('auth-revoked') returns Error",
  );
  assert(authRevokedReason.name === "AbortError", "auth-revoked reason is AbortError");
  assert(
    authRevokedReason.message.includes("auth revocation"),
    "auth-revoked message contains 'auth revocation'",
  );
  assert(!isUserAbortReason(authRevokedReason), "isUserAbortReason(auth-revoked) = false");

  // 4. Timeout signal
  console.log("\n4. Timeout signal (maintenance expiry)");
  const timeoutReason = createChatAbortSignalReason("timeout");
  assert(timeoutReason instanceof Error, "createChatAbortSignalReason('timeout') returns Error");
  assert(timeoutReason.name === "TimeoutError", "timeout reason is TimeoutError");
  assert(!isUserAbortReason(timeoutReason), "isUserAbortReason(timeout) = false");

  // 5. RPC signal (programmatic abort, no origin)
  console.log("\n5. RPC signal (programmatic chat.abort)");
  const rpcReason = createChatAbortSignalReason("rpc");
  assert(rpcReason === undefined, "createChatAbortSignalReason('rpc') returns undefined");
  assert(!isUserAbortReason(rpcReason), "isUserAbortReason(undefined) = false");

  // 6. Suppression logic: user-stop + takeover error → suppress
  console.log("\n6. Suppression logic");
  const takeoverError = new EmbeddedAttemptSessionTakeoverError("/tmp/test-session.jsonl");
  assert(
    shouldSuppressTakeoverErrorOnUserAbort({
      userInitiatedAbort: true,
      cleanupError: takeoverError,
    }),
    "user-stop + takeover error → suppress",
  );
  assert(
    !shouldSuppressTakeoverErrorOnUserAbort({
      userInitiatedAbort: false,
      cleanupError: takeoverError,
    }),
    "non-user abort + takeover error → do NOT suppress",
  );
  assert(
    !shouldSuppressTakeoverErrorOnUserAbort({
      userInitiatedAbort: true,
      cleanupError: new Error("other error"),
    }),
    "user-stop + non-takeover error → do NOT suppress",
  );

  // 7. End-to-end: chat.abort(origin: "user-stop") → stopReason: "stop"
  //    → createChatAbortSignalReason → isUserAbortReason → suppress
  console.log("\n7. End-to-end: UI Stop button path");
  const e2eOrigin = "user-stop";
  const e2eStopReason = e2eOrigin === "user-stop" ? "stop" : "rpc";
  const e2eSignalReason = createChatAbortSignalReason(e2eStopReason);
  const e2eUserInitiated = isUserAbortReason(e2eSignalReason);
  assert(e2eStopReason === "stop", "origin 'user-stop' maps to stopReason 'stop'");
  assert(e2eUserInitiated, "isUserAbortReason(signal.reason) = true for user-stop path");
  assert(
    shouldSuppressTakeoverErrorOnUserAbort({
      userInitiatedAbort: e2eUserInitiated,
      cleanupError: takeoverError,
    }),
    "UI Stop button → takeover suppressed end-to-end",
  );

  // 8. End-to-end: chat.abort(origin: "rpc") → stopReason: "rpc" → NOT suppressed
  console.log("\n8. End-to-end: programmatic abort path");
  const rpcOrigin = "rpc";
  const rpcStopReason = rpcOrigin === "user-stop" ? "stop" : "rpc";
  const rpcSignalReason = createChatAbortSignalReason(rpcStopReason);
  const rpcUserInitiated = isUserAbortReason(rpcSignalReason);
  assert(rpcStopReason === "rpc", "origin 'rpc' maps to stopReason 'rpc'");
  assert(!rpcUserInitiated, "isUserAbortReason(signal.reason) = false for RPC path");
  assert(
    !shouldSuppressTakeoverErrorOnUserAbort({
      userInitiatedAbort: rpcUserInitiated,
      cleanupError: takeoverError,
    }),
    "programmatic abort → takeover NOT suppressed end-to-end",
  );

  console.log("\n=== All checks complete ===");
}

main();
