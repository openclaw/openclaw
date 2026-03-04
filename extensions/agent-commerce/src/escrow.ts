import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Wallet as EthersWallet } from "ethers";
import { ethers } from "ethers";
import { CLAW_TOKEN_ABI } from "./contract-abi.js";

// ── Types ───────────────────────────────────────────────────────────

export type TradeState = "pending" | "locked" | "delivered" | "released" | "refunded" | "disputed";

export interface Trade {
  id: string;
  /** On-chain trade ID (bytes32 hex) */
  tradeHash: string;
  /** Listing ID from the marketplace */
  listingId: string;
  /** Buyer agent session ID */
  buyerAgentId: string;
  /** Seller agent session ID */
  sellerAgentId: string;
  /** Buyer wallet address */
  buyerAddress: string;
  /** Seller wallet address */
  sellerAddress: string;
  /** Amount in CLAW */
  amount: string;
  /** Current state */
  state: TradeState;
  /** Transaction hashes */
  txHashes: {
    escrowCreate?: string;
    release?: string;
    refund?: string;
  };
  /** ISO timestamps */
  createdAt: string;
  updatedAt: string;
}

// ── Escrow Manager ──────────────────────────────────────────────────

export class EscrowManager {
  private readonly storePath: string;
  private readonly contractAddress: string;

  constructor(stateDir: string, contractAddress: string) {
    const dir = join(stateDir, "agent-commerce");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.storePath = join(dir, "trades.json");
    this.contractAddress = contractAddress;
  }

  // ── Trade Lifecycle ─────────────────────────────────────────────

  /**
   * Step 1: Initiate a trade (off-chain record).
   * Returns a Trade object in "pending" state.
   */
  initiateTrade(params: {
    listingId: string;
    buyerAgentId: string;
    sellerAgentId: string;
    buyerAddress: string;
    sellerAddress: string;
    amount: string;
  }): Trade {
    const trades = this.loadTrades();
    const now = new Date().toISOString();
    const tradeId = `trade_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;

    // Generate a deterministic on-chain tradeId (bytes32)
    const tradeHash = ethers.keccak256(
      ethers.toUtf8Bytes(`${tradeId}:${params.buyerAddress}:${params.sellerAddress}:${now}`),
    );

    const trade: Trade = {
      id: tradeId,
      tradeHash,
      listingId: params.listingId,
      buyerAgentId: params.buyerAgentId,
      sellerAgentId: params.sellerAgentId,
      buyerAddress: params.buyerAddress,
      sellerAddress: params.sellerAddress,
      amount: params.amount,
      state: "pending",
      txHashes: {},
      createdAt: now,
      updatedAt: now,
    };

    trades.push(trade);
    this.saveTrades(trades);
    return trade;
  }

  /**
   * Step 2: Lock tokens on-chain (buyer calls createEscrow).
   * Requires prior `approve()` call on the token contract.
   */
  async lockTokens(tradeId: string, signer: EthersWallet): Promise<Trade> {
    const trade = this.getTrade(tradeId);
    if (!trade) throw new Error(`Trade ${tradeId} not found`);
    if (trade.state !== "pending") throw new Error(`Trade not in pending state: ${trade.state}`);

    const contract = new ethers.Contract(this.contractAddress, CLAW_TOKEN_ABI, signer);
    const amountWei = ethers.parseUnits(trade.amount, 18);

    // First approve the contract to spend tokens
    const approveTx = await contract.approve(this.contractAddress, amountWei);
    await approveTx.wait();

    // Create escrow on-chain
    const tx = await contract.createEscrow(trade.sellerAddress, amountWei, trade.tradeHash);
    const receipt = await tx.wait();

    return this.updateTrade(tradeId, {
      state: "locked",
      txHashes: { ...trade.txHashes, escrowCreate: receipt.hash },
    });
  }

  /**
   * Step 3: Seller marks delivery complete (off-chain signal).
   */
  markDelivered(tradeId: string): Trade {
    const trade = this.getTrade(tradeId);
    if (!trade) throw new Error(`Trade ${tradeId} not found`);
    if (trade.state !== "locked") throw new Error(`Trade not locked: ${trade.state}`);

    return this.updateTrade(tradeId, { state: "delivered" });
  }

  /**
   * Step 4: Buyer releases tokens to seller (on-chain).
   */
  async releaseTokens(tradeId: string, signer: EthersWallet): Promise<Trade> {
    const trade = this.getTrade(tradeId);
    if (!trade) throw new Error(`Trade ${tradeId} not found`);
    if (trade.state !== "locked" && trade.state !== "delivered") {
      throw new Error(`Trade not releasable: ${trade.state}`);
    }

    const contract = new ethers.Contract(this.contractAddress, CLAW_TOKEN_ABI, signer);
    const tx = await contract.releaseEscrow(trade.tradeHash);
    const receipt = await tx.wait();

    return this.updateTrade(tradeId, {
      state: "released",
      txHashes: { ...trade.txHashes, release: receipt.hash },
    });
  }

  /**
   * Step 5 (alt): Buyer refunds after timeout or dispute (on-chain).
   */
  async refundTokens(tradeId: string, signer: EthersWallet): Promise<Trade> {
    const trade = this.getTrade(tradeId);
    if (!trade) throw new Error(`Trade ${tradeId} not found`);
    if (trade.state !== "locked") throw new Error(`Trade not refundable: ${trade.state}`);

    const contract = new ethers.Contract(this.contractAddress, CLAW_TOKEN_ABI, signer);
    const tx = await contract.refundEscrow(trade.tradeHash);
    const receipt = await tx.wait();

    return this.updateTrade(tradeId, {
      state: "refunded",
      txHashes: { ...trade.txHashes, refund: receipt.hash },
    });
  }

  // ── Query ───────────────────────────────────────────────────────

  getTrade(tradeId: string): Trade | null {
    const trades = this.loadTrades();
    return trades.find((t) => t.id === tradeId) ?? null;
  }

  getTradesByAgent(agentId: string): Trade[] {
    const trades = this.loadTrades();
    return trades.filter((t) => t.buyerAgentId === agentId || t.sellerAgentId === agentId);
  }

  getActiveTrades(): Trade[] {
    const trades = this.loadTrades();
    return trades.filter(
      (t) => t.state === "pending" || t.state === "locked" || t.state === "delivered",
    );
  }

  // ── Internal ────────────────────────────────────────────────────

  private updateTrade(tradeId: string, patch: Partial<Trade>): Trade {
    const trades = this.loadTrades();
    const idx = trades.findIndex((t) => t.id === tradeId);
    if (idx === -1) throw new Error(`Trade ${tradeId} not found`);

    trades[idx] = {
      ...trades[idx],
      ...patch,
      txHashes: { ...trades[idx].txHashes, ...(patch.txHashes ?? {}) },
      updatedAt: new Date().toISOString(),
    };

    this.saveTrades(trades);
    return trades[idx];
  }

  private loadTrades(): Trade[] {
    try {
      if (!existsSync(this.storePath)) return [];
      return JSON.parse(readFileSync(this.storePath, "utf-8")) as Trade[];
    } catch {
      return [];
    }
  }

  private saveTrades(trades: Trade[]): void {
    writeFileSync(this.storePath, JSON.stringify(trades, null, 2), "utf-8");
  }
}
