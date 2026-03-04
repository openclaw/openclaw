import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying ClawToken with account:", deployer.address);

  // Mint initial supply of 1,000,000 CLAW
  const initialSupply = 1000000;

  const ClawToken = await ethers.getContractFactory("ClawToken");
  const token = await ClawToken.deploy(initialSupply);

  await token.waitForDeployment();
  const address = await token.getAddress();

  console.log("\n✅ ClawToken correctly deployed!");
  console.log("==========================================");
  console.log("Contract Address:", address);
  console.log("Initial Supply:", initialSupply, "CLAW");
  console.log("\nNext Steps:");
  console.log(`1. Copy the Contract Address.`);
  console.log(`2. Update your ~/.clawdbot/moltbot.json:`);
  console.log(`     "contractAddress": "${address}"`);
  console.log(`     "rpcUrl": "http://127.0.0.1:8545"`);
  console.log(`     "chainId": 31337`);
  console.log("==========================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
