import Openfort from "@openfort/openfort-node";
import {
  createPublicClient,
  createWalletClient,
  http,
  type WalletClient,
  type PublicClient,
  type Chain,
  type Hex,
} from "viem";
import { toAccount, type Account } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { hashAuthorization } from "viem/utils";
import { CALIBUR_IMPLEMENTATION, USDC_ADDRESSES } from "./constants.ts";
import type {
  OpenfortBackendAccount,
  OpenfortContract,
  OpenfortPolicy,
  OpenfortFeeSponsorship,
  OpenfortTransactionIntent,
} from "./openfort-types.ts";
import { extractListData } from "./openfort-types.ts";
import type { OpenfortConfig, AccountInfo } from "./types.ts";
import { USDC_FIATTOKENV2_2_ABI } from "./usdc-abi.ts";
import { openfortAddressToViem } from "./utils.ts";

export class OpenfortClient {
  private openfort: Openfort;
  private config: OpenfortConfig;
  private cachedAccount: OpenfortBackendAccount | null = null;
  private cachedWalletClient: WalletClient | null = null;
  private cachedPolicy: OpenfortPolicy | null = null;
  private cachedFeeSponsorship: OpenfortFeeSponsorship | null = null;
  private accountCreationPromise: Promise<OpenfortBackendAccount> | null = null;
  public publicClient: PublicClient;
  public chain: Chain;

  constructor(config: OpenfortConfig) {
    this.config = config;
    this.openfort = new Openfort(config.secretKey, {
      walletSecret: config.walletSecret,
    });

    // Validate network
    const network = config.network || "base-sepolia";
    if (network !== "base" && network !== "base-sepolia") {
      throw new Error(
        `Unsupported network: ${network}. Only 'base' and 'base-sepolia' are supported.`,
      );
    }

    this.chain = network === "base" ? base : baseSepolia;
    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: http(),
    });
  }

  async getOrCreateAccount(): Promise<OpenfortBackendAccount> {
    if (this.cachedAccount) return this.cachedAccount;

    // Prevent race condition: serialize account creation
    if (this.accountCreationPromise) {
      return await this.accountCreationPromise;
    }

    this.accountCreationPromise = (async () => {
      try {
        const result = await this.openfort.accounts.evm.backend.list({ limit: 1 });
        const accounts = extractListData<OpenfortBackendAccount>(result);

        if (accounts.length > 0) {
          this.cachedAccount = accounts[0];
        } else {
          const newAccount = await this.openfort.accounts.evm.backend.create();
          this.cachedAccount = newAccount as unknown as OpenfortBackendAccount;
        }

        return this.cachedAccount;
      } finally {
        this.accountCreationPromise = null;
      }
    })();

    return await this.accountCreationPromise;
  }

  async ensureDelegatedAccount(): Promise<OpenfortBackendAccount> {
    const account = await this.getOrCreateAccount();

    // Check if already delegated
    if (account.delegatedAccount) {
      return account;
    }

    // Upgrade to EIP-7702 delegated account
    const chainId = this.chain.id;
    await this.openfort.accounts.evm.backend.update({
      id: account.id,
      accountType: "Delegated Account",
      chainType: "EVM",
      chainId,
      implementationType: "Calibur",
    });

    // Re-fetch the account to get the signing methods
    const refreshedAccount = await this.openfort.accounts.evm.backend.get({ id: account.id });
    this.cachedAccount = refreshedAccount as unknown as OpenfortBackendAccount;
    return this.cachedAccount;
  }

  /**
   * Get the delegated account ID for use in transaction intents.
   * Bug Fix: backend.get() doesn't return delegatedAccount.delegatedAccount.id,
   * so we query accounts.list() to find the delegated account entry.
   */
  async getDelegatedAccountId(): Promise<string> {
    const eoaAccount = await this.getOrCreateAccount();

    // Query all accounts to find the delegated account
    const accountsResult = await this.openfort.accounts.evm.backend.list({ limit: 100 });
    const accounts = extractListData<OpenfortBackendAccount>(accountsResult);

    // Find the delegated account matching our EOA address and chain
    const delegatedAccount = accounts.find(
      (acc) =>
        acc.accountType === "Delegated Account" &&
        acc.address?.toLowerCase() === eoaAccount.address?.toLowerCase() &&
        acc.chainId === this.chain.id,
    );

    if (!delegatedAccount) {
      throw new Error("Delegated account not found after creation");
    }

    return delegatedAccount.id;
  }

  async getWalletClient(): Promise<WalletClient> {
    if (this.cachedWalletClient) return this.cachedWalletClient;

    const account = await this.getOrCreateAccount();

    const viemAccount = toAccount({
      address: openfortAddressToViem(account.address),
      async sign({ hash }: { hash: Hex }) {
        const sig = await account.sign({ hash });
        return sig as Hex;
      },
      async signMessage({ message }) {
        const msg = typeof message === "string" ? message : (message as { raw: string }).raw;
        const sig = await account.signMessage({ message: msg });
        return sig as Hex;
      },
      async signTransaction(tx) {
        const sig = await account.signTransaction(tx);
        return sig as Hex;
      },
      async signTypedData(typedData) {
        const sig = await account.signTypedData(typedData);
        return sig as Hex;
      },
    });

    this.cachedWalletClient = createWalletClient({
      account: viemAccount,
      chain: this.chain,
      transport: http(),
    });

    return this.cachedWalletClient;
  }

  async getOrCreatePolicy(): Promise<OpenfortPolicy> {
    if (this.cachedPolicy) return this.cachedPolicy;

    // Try to find existing sponsorship policy
    const policiesResult = await this.openfort.policies.list({ limit: 100 });
    const policies = extractListData<OpenfortPolicy>(policiesResult);

    const existingPolicy = policies.find((p) =>
      p.rules?.some((r) => r.operation === "sponsorEvmTransaction"),
    );

    if (existingPolicy) {
      this.cachedPolicy = existingPolicy;
      return this.cachedPolicy;
    }

    // Create new sponsorship policy
    const chainId = this.chain.id;
    const newPolicy = await this.openfort.policies.create({
      scope: "project",
      description: `Sponsor all transactions on ${this.chain.name}`,
      rules: [
        {
          action: "accept" as const,
          operation: "sponsorEvmTransaction",
          criteria: [
            {
              type: "evmNetwork",
              operator: "in",
              chainIds: [chainId],
            },
          ],
        },
      ],
    });

    this.cachedPolicy = newPolicy as unknown as OpenfortPolicy;
    return this.cachedPolicy;
  }

  async getOrCreateUSDCContract(): Promise<string> {
    // Try to find existing USDC contract for this network
    const contractsResult = await this.openfort.contracts.list({ limit: 100 });
    const contracts = extractListData<OpenfortContract>(contractsResult);

    const network = this.config.network || "base-sepolia";
    const usdcAddress = USDC_ADDRESSES[network];

    let existingContract = contracts.find(
      (c) => c.address?.toLowerCase() === usdcAddress.toLowerCase() && c.chainId === this.chain.id,
    );

    // Bug Fix: Validate that the contract has the transfer function in its ABI
    // If it doesn't, it means the proxy ABI was fetched instead of the implementation ABI
    if (existingContract) {
      const abi = existingContract.abi as Array<{ type: string; name: string }> | undefined;
      const hasTransfer = abi?.some((item) => item.type === "function" && item.name === "transfer");

      if (!hasTransfer) {
        // Contract exists but with wrong ABI (proxy instead of implementation)
        // Delete it and recreate with correct ABI
        await this.openfort.contracts.delete(existingContract.id);
        existingContract = undefined;
      } else {
        return existingContract.id;
      }
    }

    // Create new USDC contract with explicit FiatTokenV2_2 ABI
    const newContract = await this.openfort.contracts.create({
      name: `USDC - ${this.chain.name}`,
      address: usdcAddress,
      chainId: this.chain.id,
      abi: USDC_FIATTOKENV2_2_ABI as any,
    });

    return (newContract as unknown as OpenfortContract).id;
  }

  async getOrCreateFeeSponsorship(): Promise<OpenfortFeeSponsorship | null> {
    // Always enable fee sponsorship by default
    const enableSponsorship = this.config.enableFeeSponsorship !== false;

    if (!enableSponsorship) {
      return null;
    }

    if (this.cachedFeeSponsorship) return this.cachedFeeSponsorship;

    // Get or create USDC contract ID
    let usdcContractId = this.config.usdcContractId;
    if (!usdcContractId) {
      usdcContractId = await this.getOrCreateUSDCContract();
    }

    // Get or create policy first
    const policy = await this.getOrCreatePolicy();

    // Try to find existing fee sponsorship
    const sponsorshipsResult = await this.openfort.feeSponsorship.list({ limit: 100 });
    const sponsorships = extractListData<OpenfortFeeSponsorship>(sponsorshipsResult);

    const existingSponsorship = sponsorships.find((s) => s.policyId === policy.id && s.enabled);

    if (existingSponsorship) {
      this.cachedFeeSponsorship = existingSponsorship;
      return this.cachedFeeSponsorship;
    }

    // Create new fee sponsorship with dynamic USDC pricing
    const newSponsorship = await this.openfort.feeSponsorship.create({
      name: `Dynamic USDC gas payment - ${this.chain.name}`,
      strategy: {
        sponsorSchema: "charge_custom_tokens" as const,
        tokenContract: usdcContractId,
        // Omit tokenContractAmount for dynamic pricing
      },
      policyId: policy.id,
    });

    this.cachedFeeSponsorship = newSponsorship as unknown as OpenfortFeeSponsorship;
    return this.cachedFeeSponsorship;
  }

  async sendTransactionIntent(params: {
    contractAddress: string;
    functionName: string;
    functionArgs: unknown[];
  }): Promise<OpenfortTransactionIntent> {
    await this.ensureDelegatedAccount();
    const eoaAccount = await this.getOrCreateAccount();
    const delegatedAccountId = await this.getDelegatedAccountId();

    // Check if EIP-7702 authorization is needed
    const code = await this.publicClient.getBytecode({
      address: openfortAddressToViem(eoaAccount.address),
    });
    const needsAuth = !code;

    let authSignature: string | undefined;

    if (needsAuth) {
      // Create and sign EIP-7702 authorization
      // IMPORTANT: Must use viem's hashAuthorization() utility.
      // Manual hashing with keccak256(0x05 || rlp(...)) will produce
      // a different hash because EIP-7702 has specific encoding rules.
      const eoaNonce = await this.publicClient.getTransactionCount({
        address: openfortAddressToViem(eoaAccount.address),
      });

      const authHash = hashAuthorization({
        contractAddress: CALIBUR_IMPLEMENTATION,
        chainId: this.chain.id,
        nonce: eoaNonce,
      });

      authSignature = await eoaAccount.sign({ hash: authHash });
    }

    // Create transaction intent
    const intentParams: {
      account: string;
      chainId: number;
      optimistic: boolean;
      interactions: Array<{
        contract: string;
        functionName: string;
        functionArgs: unknown[];
      }>;
      signedAuthorization?: string;
    } = {
      account: delegatedAccountId,
      chainId: this.chain.id,
      optimistic: false,
      interactions: [
        {
          contract: params.contractAddress,
          functionName: params.functionName,
          functionArgs: params.functionArgs,
        },
      ],
    };

    if (needsAuth && authSignature) {
      intentParams.signedAuthorization = authSignature;
    }

    let intent = await this.openfort.transactionIntents.create(intentParams);

    // Sign the user operation if required
    const typedIntent = intent as unknown as OpenfortTransactionIntent;
    if (typedIntent.nextAction?.type === "sign_with_wallet") {
      const signableHash = typedIntent.nextAction.payload?.signableHash;
      if (signableHash) {
        const txSignature = await eoaAccount.sign({ hash: signableHash });

        intent = await this.openfort.transactionIntents.signature(typedIntent.id, {
          signature: txSignature,
        });
      }
    }

    return intent as unknown as OpenfortTransactionIntent;
  }

  async waitForTransactionReceipt(txHash: Hex, timeout = 60000) {
    return await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout,
    });
  }

  async listAccounts(limit: number = 10): Promise<AccountInfo[]> {
    const result = await this.openfort.accounts.evm.backend.list({ limit });
    const accounts = extractListData<OpenfortBackendAccount>(result);

    return accounts.map((acc) => ({
      id: acc.id,
      address: openfortAddressToViem(acc.address),
      custody: acc.custody,
      delegatedAccount: acc.delegatedAccount,
    }));
  }

  cleanup() {
    this.cachedAccount = null;
    this.cachedWalletClient = null;
    this.cachedPolicy = null;
    this.cachedFeeSponsorship = null;
    this.accountCreationPromise = null;
  }
}
