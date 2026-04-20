import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CACHE_DIR = join(homedir(), ".openclaw", "cache", "coperniq");

try {
  const workOrders = JSON.parse(readFileSync(join(CACHE_DIR, "work-orders.json"), "utf-8"));
  const projects = JSON.parse(readFileSync(join(CACHE_DIR, "projects.json"), "utf-8"));
  const accounts = JSON.parse(readFileSync(join(CACHE_DIR, "accounts.json"), "utf-8"));

  const projectMap = new Map();
  for (const p of projects) {
    projectMap.set(p.id, p);
  }

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

  const customerData = [];
  const processedAccountIds = new Set();

  for (const wo of completedSolarInstallWOs) {
    const project = wo.project ? projectMap.get(wo.project.id) : undefined;
    if (project && project.accountId && !processedAccountIds.has(project.accountId)) {
      const account = accountMap.get(project.accountId);
      if (account) {
        const name = account.title || "N/A";
        const phone = account.primaryPhone || "N/A";
        const address =
          account.address && account.address.length > 0
            ? account.address[0].replace(/\\n/g, ", ")
            : "N/A";
        customerData.push({ name, phone, address });
        processedAccountIds.add(project.accountId);
      }
    }
  }

  if (customerData.length === 0) {
    console.log('No customers found with completed "Solar Installation" work orders.');
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
