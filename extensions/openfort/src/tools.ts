import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, PluginLogger } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { erc20Abi, formatEther, formatUnits, parseEther, parseUnits } from "viem";
import { OpenfortClient } from "./client.ts";
import { USDC_ADDRESSES } from "./constants.ts";
import type { OpenfortConfig } from "./types.ts";
import { toAddress } from "./utils.ts";

/**
 * Note on USDC ABI:
 * USDC uses the FiatTokenV2_2 implementation, but the standard erc20Abi from viem
 * works perfectly for all user-facing operations (balanceOf, transfer, approve).
 * The proxy pattern is transparent for these standard ERC20 methods.
 */

export function createTools(
  client: OpenfortClient,
  config: OpenfortConfig,
  logger: PluginLogger,
): AnyAgentTool[] {
  const network = config.network || "base-sepolia";
  const USDC_ADDRESS = USDC_ADDRESSES[network];
  // Fee sponsorship enabled by default unless explicitly disabled
  const useSponsoredTransactions = config.enableFeeSponsorship !== false;

  if (!USDC_ADDRESS) {
    throw new Error(`USDC address not found for network: ${network}`);
  }

  return [
    {
      name: "openfort_get_wallet_address",
      label: "Get Openfort Wallet Address",
      description: "Get the address of the Openfort backend wallet",
      parameters: Type.Object({}),
      execute: async () => {
        const account = await client.getOrCreateAccount();
        return jsonResult({
          address: account.address,
          network,
          delegated: !!account.delegatedAccount,
          message: `Wallet address: ${account.address} on ${network}${account.delegatedAccount ? " (EIP-7702 delegated)" : ""}`,
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
          chain: client.chain,
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
      description: useSponsoredTransactions
        ? "Send USDC with gas paid in USDC (EIP-7702 delegated account with fee sponsorship)"
        : "Send USDC from the Openfort wallet to a recipient (requires ETH for gas)",
      parameters: Type.Object({
        to: Type.String({ description: "Recipient address (0x...)" }),
        amount: Type.String({ description: 'Amount in USDC (e.g., "10.50")' }),
      }),
      execute: async (_toolCallId, input: { to: string; amount: string }) => {
        const recipientAddress = toAddress(input.to);
        const usdcAmount = parseUnits(input.amount, 6);

        if (useSponsoredTransactions) {
          // Use transaction intents with fee sponsorship
          logger.info("Using transaction intent with USDC gas sponsorship");

          // Ensure fee sponsorship is set up and get the contract ID
          const feeSponsorship = await client.getOrCreateFeeSponsorship();
          const contractId =
            config.usdcContractId ||
            (feeSponsorship?.strategy?.tokenContract as string) ||
            (await client.getOrCreateUSDCContract());

          const intent = await client.sendTransactionIntent({
            contractAddress: contractId,
            functionName: "transfer",
            functionArgs: [recipientAddress, usdcAmount.toString()],
          });

          if (intent.response?.transactionHash) {
            const receipt = await client.waitForTransactionReceipt(
              intent.response.transactionHash as `0x${string}`,
            );

            return jsonResult({
              hash: intent.response.transactionHash,
              intentId: intent.id,
              from: receipt.from,
              to: input.to,
              amount: `${input.amount} USDC`,
              network,
              gasPayment: "USDC (sponsored)",
              blockNumber: receipt.blockNumber.toString(),
              status: receipt.status,
            });
          }

          return jsonResult({
            intentId: intent.id,
            status: intent.status,
            to: input.to,
            amount: `${input.amount} USDC`,
            network,
            message: "Transaction intent created but not yet confirmed",
          });
        } else {
          // Fallback to regular viem transaction (requires ETH for gas)
          logger.info("Using viem writeContract (requires ETH for gas)");

          const walletClient = await client.getWalletClient();
          const hash = await walletClient.writeContract({
            account: walletClient.account!,
            address: USDC_ADDRESS,
            abi: erc20Abi,
            functionName: "transfer",
            args: [recipientAddress, usdcAmount],
            chain: walletClient.chain,
          });

          return jsonResult({
            hash,
            from: walletClient.account!.address,
            to: input.to,
            amount: `${input.amount} USDC`,
            token: USDC_ADDRESS,
            network,
            gasPayment: "ETH",
          });
        }
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
            delegated: !!acc.delegatedAccount,
          })),
        });
      },
    },
  ];
}
