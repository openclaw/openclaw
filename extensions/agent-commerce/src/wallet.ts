import type { JsonRpcProvider, Wallet as EthersWallet } from "ethers";
import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CLAW_TOKEN_ABI, CHAIN_CONFIGS } from "./contract-abi.js";

// ── Types ───────────────────────────────────────────────────────────

export interface WalletInfo {
  address: string;
  privateKey: string;
  createdAt: string;
}

export interface WalletBalance {
  address: string;
  claw: string;
  clawRaw: string;
  eth: string;
}

export interface CommerceConfig {
  rpcUrl?: string;
  contractAddress?: string;
  chainId?: number;
}

// ── Wallet Manager ──────────────────────────────────────────────────

export class WalletManager {
  private readonly stateDir: string;
  private readonly walletPath: string;
  private provider: JsonRpcProvider | null = null;
  private wallet: EthersWallet | null = null;
  private config: CommerceConfig;

  constructor(stateDir: string, config: CommerceConfig = {}) {
    this.stateDir = stateDir;
    this.walletPath = join(stateDir, "agent-commerce", "wallet.json");
    this.config = {
      rpcUrl: config.rpcUrl ?? CHAIN_CONFIGS.baseSepolia.rpcUrl,
      chainId: config.chainId ?? CHAIN_CONFIGS.baseSepolia.chainId,
      contractAddress: config.contractAddress,
    };
  }

  // ── Connection ──────────────────────────────────────────────────

  private getProvider(): JsonRpcProvider {
    if (!this.provider) {
      this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl, this.config.chainId);
    }
    return this.provider;
  }

  private getWallet(): EthersWallet {
    if (!this.wallet) {
      const info = this.loadWallet();
      if (!info) {
        throw new Error("No wallet found. Run wallet.create() first.");
      }
      this.wallet = new ethers.Wallet(info.privateKey, this.getProvider());
    }
    return this.wallet;
  }

  // ── Wallet CRUD ─────────────────────────────────────────────────

  /**
   * Create a new wallet keypair and persist it.
   * Returns the wallet address (public).
   */
  create(): WalletInfo {
    const existing = this.loadWallet();
    if (existing) {
      return existing;
    }

    const randomWallet = ethers.Wallet.createRandom();
    const info: WalletInfo = {
      address: randomWallet.address,
      privateKey: randomWallet.privateKey,
      createdAt: new Date().toISOString(),
    };

    this.saveWallet(info);
    this.wallet = null; // Reset cached wallet
    return info;
  }

  /**
   * Import a wallet from a private key.
   */
  importKey(privateKey: string): WalletInfo {
    const imported = new ethers.Wallet(privateKey);
    const info: WalletInfo = {
      address: imported.address,
      privateKey: imported.privateKey,
      createdAt: new Date().toISOString(),
    };

    this.saveWallet(info);
    this.wallet = null;
    return info;
  }

  /**
   * Get the current wallet address (public).
   */
  getAddress(): string | null {
    const info = this.loadWallet();
    return info?.address ?? null;
  }

  /**
   * Check if a wallet exists.
   */
  hasWallet(): boolean {
    return this.loadWallet() !== null;
  }

  // ── Balance ─────────────────────────────────────────────────────

  /**
   * Get CLAW token balance and native ETH balance.
   */
  async getBalance(): Promise<WalletBalance> {
    const wallet = this.getWallet();
    const provider = this.getProvider();

    const ethBalance = await provider.getBalance(wallet.address);

    let clawBalance = BigInt(0);
    if (this.config.contractAddress) {
      const contract = new ethers.Contract(this.config.contractAddress, CLAW_TOKEN_ABI, provider);
      clawBalance = await contract.balanceOf(wallet.address);
    }

    return {
      address: wallet.address,
      claw: ethers.formatUnits(clawBalance, 18),
      clawRaw: clawBalance.toString(),
      eth: ethers.formatEther(ethBalance),
    };
  }

  // ── Token Operations ────────────────────────────────────────────

  /**
   * Approve the contract to spend tokens (required before escrow).
   */
  async approveSpending(amount: string): Promise<string> {
    if (!this.config.contractAddress) {
      throw new Error("Contract address not configured");
    }

    const wallet = this.getWallet();
    const contract = new ethers.Contract(this.config.contractAddress, CLAW_TOKEN_ABI, wallet);

    const amountWei = ethers.parseUnits(amount, 18);
    const tx = await contract.approve(this.config.contractAddress, amountWei);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Transfer CLAW tokens to another address.
   */
  async transfer(to: string, amount: string): Promise<string> {
    if (!this.config.contractAddress) {
      throw new Error("Contract address not configured");
    }

    const wallet = this.getWallet();
    const contract = new ethers.Contract(this.config.contractAddress, CLAW_TOKEN_ABI, wallet);

    const amountWei = ethers.parseUnits(amount, 18);
    const tx = await contract.transfer(to, amountWei);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Get the connected signer for external use (escrow, etc.).
   */
  getSigner(): EthersWallet {
    return this.getWallet();
  }

  /**
   * Get the contract address.
   */
  getContractAddress(): string | null {
    return this.config.contractAddress ?? null;
  }

  // ── Persistence ─────────────────────────────────────────────────

  private loadWallet(): WalletInfo | null {
    try {
      if (!existsSync(this.walletPath)) {
        return null;
      }
      const raw = readFileSync(this.walletPath, "utf-8");
      return JSON.parse(raw) as WalletInfo;
    } catch {
      return null;
    }
  }

  private saveWallet(info: WalletInfo): void {
    const dir = join(this.stateDir, "agent-commerce");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.walletPath, JSON.stringify(info, null, 2), "utf-8");
  }
}
