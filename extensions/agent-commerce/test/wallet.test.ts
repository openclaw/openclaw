import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { WalletManager } from "../src/wallet.js";

describe("WalletManager", () => {
  let stateDir: string;
  let wallet: WalletManager;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "wallet-test-"));
    wallet = new WalletManager(stateDir);
  });

  it("should create a new wallet", () => {
    expect(wallet.hasWallet()).toBe(false);
    const info = wallet.create();

    expect(info.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(info.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(wallet.hasWallet()).toBe(true);
  });

  it("should return existing wallet if already created", () => {
    const first = wallet.create();
    const second = wallet.create();
    expect(first.address).toBe(second.address);
  });

  it("should import a private key", () => {
    // Well-known test key (never use this with real funds!)
    const testKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const info = wallet.importKey(testKey);

    expect(info.address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(wallet.hasWallet()).toBe(true);
    expect(wallet.getAddress()).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  it("should persist wallet across instances", () => {
    wallet.create();
    const address = wallet.getAddress();

    // Create a new WalletManager pointing to the same stateDir
    const wallet2 = new WalletManager(stateDir);
    expect(wallet2.hasWallet()).toBe(true);
    expect(wallet2.getAddress()).toBe(address);
  });
});
