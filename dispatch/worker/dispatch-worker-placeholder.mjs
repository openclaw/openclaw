const HEARTBEAT_MS = 30_000;

const identity = "dispatch-worker-placeholder";

const renderLine = () => {
  const now = new Date().toISOString();
  console.log(`[${identity}] heartbeat ${now}`);
};

let timer = setInterval(renderLine, HEARTBEAT_MS);
renderLine();

const shutdown = async (signal) => {
  clearInterval(timer);
  console.log(`[${identity}] ${signal}: shutting down.`);
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

console.log(`[${identity}] started for demo profile; no-op mode enabled.`);
