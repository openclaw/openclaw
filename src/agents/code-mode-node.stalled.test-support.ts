import { parentPort } from "node:worker_threads";

// A live worker that never acknowledges startup or input must still time out.
parentPort?.on("message", () => {});
