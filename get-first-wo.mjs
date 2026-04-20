import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CACHE_DIR = join(homedir(), ".openclaw", "cache", "coperniq");

try {
  const workOrders = JSON.parse(readFileSync(join(CACHE_DIR, "work-orders.json"), "utf-8"));

  const wo = workOrders.find(
    (wo) =>
      wo.title?.toLowerCase().includes("solar") &&
      wo.title?.toLowerCase().includes("installation") &&
      wo.status === "Completed",
  );

  if (wo) {
    console.log(JSON.stringify(wo, null, 2));
  } else {
    console.log("No matching work order found.");
  }
} catch (error) {
  console.error("An error occurred:", error.message);
  process.exit(1);
}
