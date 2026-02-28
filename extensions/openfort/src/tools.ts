import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, PluginLogger } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { erc20Abi, formatEther, formatUnits, parseEther, parseUnits } from "viem";
import { OpenfortClient } from "./client.js";
import { USDC_ADDRESSES } from "./constants.js";
import type { OpenfortConfig } from "./types.js";
import { toAddress } from "./utils.js";

export function createTools(
  client: OpenfortClient,
  config: OpenfortConfig,
  logger: PluginLogger,
): AnyAgentTool[] {
  const network = config.network || "base-sepolia";
  const USDC_ADDRESS = USDC_ADDRESSES[network];

  return [
    {
      name: "openfort_get_wallet_address",
      label: "Get Openfort Wallet Address",
      description: "Get the address of the Openfort backend wallet",
      parameters: Type.Object({}),
      execute: async () => {
        const walletClient = await client.getWalletClient();
        const address = walletClient.account!.address;
        return jsonResult({
          address,
          network,
          message: `Wallet address: ${address} on ${network}`,
        });
      },
    },
    {
      name: "openfort_sign_message",
      label: "Sign Message",
      description: "Sign a message with the Openfort backend wallet (EIP-191)",
      parameters: Type.Object({
        message: Type.String({ description: "The message to sign" }),
      }),
      execute: async (_toolCallId, input: { message: string }) => {
        const walletClient = await client.getWalletClient();
        const signature = await walletClient.signMessage({
          account: walletClient.account!,
          message: input.message,
        });
        return jsonResult({
          signature,
          message: input.message,
          address: walletClient.account!.address,
        });
      },
    },
    {
      name: "openfort_get_balance",
      label: "Get Wallet Balance",
      description: "Get the ETH and USDC balances of the Openfort wallet",
      parameters: Type.Object({}),
      execute: async () => {
        const walletClient = await client.getWalletClient();
        const address = walletClient.account!.address;

        const [ethBalance, usdcBalance] = await Promise.all([
          client.publicClient.getBalance({ address }),
          client.publicClient.readContract({
            address: USDC_ADDRESS,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
          }),
        ]);

        return jsonResult({
          address,
          network,
          eth: formatEther(ethBalance),
          usdc: formatUnits(usdcBalance, 6),
        });
      },
    },
    {
      name: "openfort_send_eth",
      label: "Send ETH",
      description: "Send ETH from the Openfort wallet to a recipient",
      parameters: Type.Object({
        to: Type.String({ description: "Recipient address (0x...)" }),
        amount: Type.String({ description: 'Amount in ETH (e.g., "0.001")' }),
      }),
      execute: async (_toolCallId, input: { to: string; amount: string }) => {
        const walletClient = await client.getWalletClient();
        const hash = await walletClient.sendTransaction({
          account: walletClient.account!,
          to: toAddress(input.to),
          value: parseEther(input.amount),
        });
        return jsonResult({
          hash,
          from: walletClient.account!.address,
          to: input.to,
          amount: `${input.amount} ETH`,
          network,
        });
      },
    },
    {
      name: "openfort_send_usdc",
      label: "Send USDC",
      description: "Send USDC from the Openfort wallet to a recipient",
      parameters: Type.Object({
        to: Type.String({ description: "Recipient address (0x...)" }),
        amount: Type.String({ description: 'Amount in USDC (e.g., "10.50")' }),
      }),
      execute: async (_toolCallId, input: { to: string; amount: string }) => {
        const walletClient = await client.getWalletClient();
        const hash = await walletClient.writeContract({
          account: walletClient.account!,
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: "transfer",
          args: [toAddress(input.to), parseUnits(input.amount, 6)],
          chain: walletClient.chain,
        });
        return jsonResult({
          hash,
          from: walletClient.account!.address,
          to: input.to,
          amount: `${input.amount} USDC`,
          token: USDC_ADDRESS,
          network,
        });
      },
    },
    {
      name: "openfort_list_accounts",
      label: "List Accounts",
      description: "List all Openfort backend wallet accounts",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Maximum number of accounts to return" })),
      }),
      execute: async (_toolCallId, input: { limit?: number }) => {
        const accounts = await client.listAccounts(input.limit || 10);
        return jsonResult({
          count: accounts.length,
          accounts: accounts.map((acc) => ({
            id: acc.id,
            address: acc.address,
          })),
        });
      },
    },
  ];
}
