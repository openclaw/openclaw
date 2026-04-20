import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CACHE_DIR = join(homedir(), ".openclaw", "cache", "coperniq");

try {
  const workOrders = JSON.parse(readFileSync(join(CACHE_DIR, "work-orders.json"), "utf-8"));
  const accounts = JSON.parse(readFileSync(join(CACHE_DIR, "accounts.json"), "utf-8"));

  const accountMap = new Map();
  for (const acc of accounts) {
    accountMap.set(acc.id, acc);
  }

  const completedSolarInstallWOs = workOrders.filter(
    (wo) =>
      wo.title?.toLowerCase().includes("solar") &&
      wo.title?.toLowerCase().includes("installation") &&
      wo.status === "Completed",
  );

  console.log(`Found ${completedSolarInstallWOs.length} work orders matching the criteria.`);

  const customerData = [];
  const processedAccountIds = new Set();

  for (const wo of completedSolarInstallWOs) {
    console.log(`Processing WO ${wo.id} with accountId: ${wo.accountId}`);
    if (wo.accountId && !processedAccountIds.has(wo.accountId)) {
      const account = accountMap.get(wo.accountId);
      if (account) {
        console.log(`  -> Found account: ${account.title}`);
        const name = account.title || "N/A";
        const phone = account.primaryPhone || "N/A";
        const address = account.address ? account.address.replace(/\\n/g, ", ") : "N/A";
        customerData.push({ name, phone, address });
        processedAccountIds.add(wo.accountId);
      } else {
        console.log(`  -> ERROR: Account not found for accountId: ${wo.accountId}`);
      }
    } else {
      console.log(`  -> Skipping WO: No accountId or already processed.`);
    }
  }

  if (customerData.length === 0) {
    console.log("No customers found to add to CSV.");
    process.exit(0);
  }

  let csvContent = "Name,Phone,Address\n";
  for (const customer of customerData) {
    const name = `"${customer.name.replace(/"/g, '""')}"`;
    const phone = `"${customer.phone.replace(/"/g, '""')}"`;
    const address = `"${customer.address.replace(/"/g, '""')}"`;
    csvContent += `${name},${phone},${address}\n`;
  }

  const outputPath = join(process.cwd(), "solar_installation_customers.csv");
  writeFileSync(outputPath, csvContent);
  console.log(`Successfully created CSV file at: ${outputPath}`);
} catch (error) {
  console.error("An error occurred:", error.message);
  process.exit(1);
}
