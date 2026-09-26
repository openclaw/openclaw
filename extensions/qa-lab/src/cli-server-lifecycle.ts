type InterruptibleServer = {
  baseUrl: string;
  stop(): Promise<void>;
};

export async function runInterruptibleServer(label: string, server: InterruptibleServer) {
  process.stdout.write(`${label}: ${server.baseUrl}\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");

  let onSignal: () => void;
  const detach = () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let shutdown: Promise<void> | undefined;
      onSignal = () => {
        // Keep the first stop joined, but restore the operator's second-signal
        // escape without removing another owner's handlers.
        detach();
        if (shutdown) {
          return;
        }
        shutdown = Promise.resolve().then(() => server.stop());
        void shutdown.then(resolve, reject);
        process.stderr.write(
          "Stopping. Interrupt again to exit immediately; cleanup and report completion will be unconfirmed.\n",
        );
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
    });
  } finally {
    detach();
  }
  process.exit(0);
}
