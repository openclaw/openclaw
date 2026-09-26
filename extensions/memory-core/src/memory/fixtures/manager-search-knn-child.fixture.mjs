import process from "node:process";

process.on("SIGTERM", () => {
  // Force the parent test through its SIGKILL path.
});

let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += chunk.toString("utf8");
  if (!buffered.endsWith("\n")) {
    return;
  }
  const input = JSON.parse(buffered);
  buffered = "";
  const mode = input.request.providerModels[0]?.startsWith("fixture:")
    ? input.request.providerModels[0]
    : input.databasePath;
  if (mode === "fixture:malformed") {
    process.stdout.write("not-json\n");
    return;
  }
  if (mode === "fixture:oversized") {
    process.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1024, 120));
    return;
  }
  if (mode === "fixture:oversized-stderr") {
    process.stderr.write(Buffer.alloc(64 * 1024 + 1024, 120));
    return;
  }
  if (mode === "fixture:early-exit") {
    // Flush pipe output before exiting so the test cannot lose its own diagnostic.
    process.stderr.write("fixture KNN failure\n", () => process.exit(7));
    return;
  }
  process.stderr.write("ready\n");
  const deadline = performance.now() + Math.max(0, Number(input.request?.limit ?? 0));
  while (performance.now() < deadline) {
    // Model a synchronous native SQLite call that cannot service messages.
  }
  const response =
    JSON.stringify({
      id: mode === "fixture:wrong-id" ? input.id - 1 : input.id,
      status: "ok",
      value: { rows: [], fallbackScanRequired: false },
    }) + "\n";
  if (mode === "fixture:fragmented") {
    process.stdout.write(response.slice(0, 10));
    setImmediate(() => process.stdout.write(response.slice(10)));
  } else {
    process.stdout.write(mode === "fixture:extra" ? response + response : response);
  }
});
process.stdin.resume();
