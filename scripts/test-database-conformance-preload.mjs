import { setEnvironmentData } from "node:worker_threads";

const connection = new URL(import.meta.url).searchParams.get("connection");
if (!connection) {
  throw new Error("Database conformance preload requires a connection");
}
setEnvironmentData("openclaw.test.workboard.connection", connection);
setEnvironmentData("openclaw.test.state.conformance.connection", connection);
