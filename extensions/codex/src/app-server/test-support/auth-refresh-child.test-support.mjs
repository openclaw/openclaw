import { createInterface } from "node:readline";

// Only the transport is synthetic. The parent handles refresh through its real
// client runtime, auth bridge, OAuth manager, and private persisted profile.
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const output =
    message.method === "fixture/send-request"
      ? message.params
      : { method: "fixture/refresh-response", params: message };
  process.stdout.write(`${JSON.stringify(output)}\n`);
});
