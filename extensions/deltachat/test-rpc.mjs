import { startDeltaChat } from "./node_modules/@deltachat/stdio-rpc-server/index.js";

async function main() {
  const dc = await startDeltaChat("/tmp/test-dc-data");

  // Add an account
  const accountId = await dc.rpc.addAccount();
  console.log("Created account:", accountId);

  // Get account info
  const info = await dc.rpc.getAccountInfo(accountId);
  console.log("Account info:", JSON.stringify(info, null, 2));

  // List all accounts
  const accounts = await dc.rpc.getAllAccounts();
  console.log("All accounts:", JSON.stringify(accounts, null, 2));

  dc.close();
}
main().catch(console.error);
