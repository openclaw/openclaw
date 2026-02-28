import Openfort from "@openfort/openfort-node";
import {
  createPublicClient,
  createWalletClient,
  http,
  type WalletClient,
  type PublicClient,
  type Chain,
} from "viem";
import { toAccount, type Account } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { OpenfortConfig, AccountInfo } from "./types.js";
import { openfortAddressToViem } from "./utils.js";

export class OpenfortClient {
  private openfort: Openfort;
  private config: OpenfortConfig;
  private cachedAccount: any = null;
  private cachedWalletClient: WalletClient<any, Chain, Account> | null = null;
  public publicClient: PublicClient<any, Chain>;

  constructor(config: OpenfortConfig) {
    this.config = config;
    this.openfort = new Openfort(config.secretKey, {
      walletSecret: config.walletSecret,
    });

    const chain = config.network === "base" ? base : baseSepolia;
    this.publicClient = createPublicClient({ chain, transport: http() }) as PublicClient<
      any,
      Chain
    >;
  }

  async getOrCreateAccount(): Promise<any> {
    if (this.cachedAccount) return this.cachedAccount;

    const result = await this.openfort.accounts.evm.backend.list({ limit: 1 });
    const accounts = (result as any).data || (result as any).accounts || [];
    this.cachedAccount = accounts[0] || (await this.openfort.accounts.evm.backend.create());

    return this.cachedAccount;
  }

  async getWalletClient(): Promise<WalletClient<any, Chain, Account>> {
    if (this.cachedWalletClient) return this.cachedWalletClient;

    const account = await this.getOrCreateAccount();
    const chain = this.config.network === "base" ? base : baseSepolia;

    const viemAccount = toAccount({
      address: openfortAddressToViem(account.address),
      sign: async ({ hash }: { hash: `0x${string}` }) => {
        const sig = await account.sign({ hash: hash as string });
        return sig as `0x${string}`;
      },
      signMessage: async ({ message }: any) => {
        const msg = typeof message === "string" ? message : message.raw;
        const sig = await account.signMessage({ message: msg });
        return sig as `0x${string}`;
      },
      signTransaction: async (tx: any) => {
        const sig = await account.signTransaction(tx);
        return sig as `0x${string}`;
      },
      signTypedData: async (typedData: any) => {
        const sig = await account.signTypedData(typedData);
        return sig as `0x${string}`;
      },
    });

    this.cachedWalletClient = createWalletClient({
      account: viemAccount,
      chain,
      transport: http(),
    });

    return this.cachedWalletClient;
  }

  async listAccounts(limit: number = 10): Promise<AccountInfo[]> {
    const result = await this.openfort.accounts.evm.backend.list({ limit });
    const accounts = (result as any).data || (result as any).accounts || [];
    return accounts.map((acc: any) => ({
      id: acc.id,
      address: openfortAddressToViem(acc.address),
      custody: acc.custody,
      delegatedAccount: acc.delegatedAccount,
    }));
  }

  cleanup() {
    this.cachedAccount = null;
    this.cachedWalletClient = null;
  }
}
