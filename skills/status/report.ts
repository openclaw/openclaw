async function main() {
  const args = process.argv.slice(2);
  const action = args[0]; // Should be 'TASK'
  const description = args[1];
  const details = args[2] || "";

  if (!action || !description) {
    console.error("Usage: node report.ts <action> <description> [details]");
    process.exit(1);
  }

  // Emit a structured log that the Studio UI can pick up (if it parses logs)
  // But primarily, the tool call itself is the event.
  // We output JSON for clarity.
  const statusUpdate = {
    type: "status_update",
    action,
    description,
    details,
    timestamp: Date.now(),
  };

  console.log(JSON.stringify(statusUpdate));
}

main();
