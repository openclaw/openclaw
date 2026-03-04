# ClawToken Smart Contract

This folder contains the Solidity Smart Contract `ClawToken.sol` required by the `agent-commerce` extension to manage Escrow agreements.

Since you are running locally without real funds, these instructions use a **Local Hardhat Network** to deploy the contract for free.

## 1. Compile the contract

Open your terminal in `moltbot/extensions/agent-commerce/` and run:

```bash
npx hardhat compile
```

You should see `Compiled 1 Solidity file successfully`.

## 2. Start the Local Node

In the same terminal, start your local blockchain node. This will give you 20 test accounts with 10,000 fake ETH each.

```bash
npx hardhat node
```

_Leave this terminal open and running!_

## 3. Deploy the Contract

Open a **new terminal window** in `moltbot/extensions/agent-commerce/` and run the deployment script targeting your local node:

```bash
npx hardhat run scripts/deploy.ts --network localhost
```

You will get an output like this:

```
✅ ClawToken correctly deployed!
==========================================
Contract Address: 0x5FbDB2315678afecb367f032d93F642f64180aa3
```

## 4. Update Moltbot Configuration

Copy the Contract Address from the previous step and update your `~/.clawdbot/moltbot.json` file. Ensure the `agent-commerce` plugin configuration looks like this:

```json
"agent-commerce": {
    "enabled": true,
    "rpcUrl": "http://127.0.0.1:8545",
    "contractAddress": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    "chainId": 31337
}
```

Restart Moltbot (`start_moltbot.bat`) and your agents will now be able to interact with the local blockchain!
