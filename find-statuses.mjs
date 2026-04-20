import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CACHE_DIR = join(homedir(), ".openclaw", "cache", "coperniq");

try {
  const workOrders = JSON.parse(readFileSync(join(CACHE_DIR, "work-orders.json"), "utf-8"));

  const solarInstallWOs = workOrders.filter(
    (wo) =>
      wo.title?.toLowerCase().includes("solar") && wo.title?.toLowerCase().includes("installation"),
  );

  const uniqueStatuses = new Set();
  for (const wo of solarInstallWOs) {
    if (wo.status) {
      uniqueStatuses.add(wo.status);
    }
  }

  if (uniqueStatuses.size === 0) {
    console.log('No "Solar Installation" work orders found to check statuses.');
  } else {
    console.log('Unique statuses for "Solar Installation" work orders:');
    console.log(Array.from(uniqueStatuses));
  }
} catch (error) {
  console.error("An error occurred:", error.message);
  process.exit(1);
}
