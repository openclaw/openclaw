import { parentPort } from "node:worker_threads";

if (!parentPort) {
  throw new Error("Expected Telegram ingress fixture Worker");
}
parentPort.on("message", (message) => {
  if (message.type === "stop") {
    parentPort.close();
  }
});
parentPort.postMessage({ type: "spooled", updateId: 7, queued: 1 }, []);
