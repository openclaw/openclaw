// The benchmark owns this IPC channel; Gateway's existing SIGINT handler owns cleanup.
const owner = new URL(import.meta.url);
if (
  process.send &&
  process.ppid === Number(owner.searchParams.get("parentPid")) &&
  process.argv[1] === owner.searchParams.get("entry")
) {
  process.on("message", function stop(message) {
    if (message !== "openclaw-startup-benchmark:stop") {
      return;
    }
    process.off("message", stop);
    process.channel?.ref();
    const accepted = process.listenerCount("SIGINT") > 0;
    void import("node:module").then(({ getCompileCacheDir }) => {
      process.send(
        {
          type: "openclaw-startup-benchmark:stopping",
          accepted,
          compileCacheDir: getCompileCacheDir() ?? null,
        },
        () => {
          process.channel?.unref();
          if (accepted) {
            process.emit("SIGINT");
          }
        },
      );
    });
  });
  process.channel?.unref();
}
