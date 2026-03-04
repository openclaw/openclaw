/**
 * ClawToken ABI — Subset used by the agent-commerce extension.
 *
 * Generated from `contracts/ClawToken.sol`.
 * Only includes functions the extension actively calls.
 */
export const CLAW_TOKEN_ABI = [
  // ── ERC-20 standard ──────────────────────────────────────────────
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",

  // ── Escrow ───────────────────────────────────────────────────────
  "function createEscrow(address seller, uint256 amount, bytes32 tradeId)",
  "function releaseEscrow(bytes32 tradeId)",
  "function refundEscrow(bytes32 tradeId)",
  "function escrows(bytes32 tradeId) view returns (address buyer, address seller, uint256 amount, uint256 createdAt, uint256 expiresAt, uint8 state)",
  "function escrowTimeout() view returns (uint256)",

  // ── Admin ────────────────────────────────────────────────────────
  "function mint(address to, uint256 amount)",
  "function setEscrowTimeout(uint256 newTimeout)",
  "function owner() view returns (address)",

  // ── Events ───────────────────────────────────────────────────────
  "event EscrowCreated(bytes32 indexed tradeId, address indexed buyer, address indexed seller, uint256 amount, uint256 expiresAt)",
  "event EscrowReleased(bytes32 indexed tradeId, address indexed seller, uint256 amount)",
  "event EscrowRefunded(bytes32 indexed tradeId, address indexed buyer, uint256 amount)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
] as const;

/** Default chain configs */
export const CHAIN_CONFIGS = {
  /** Base Sepolia Testnet */
  baseSepolia: {
    chainId: 84532,
    name: "Base Sepolia",
    rpcUrl: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
  },
  /** Base Mainnet */
  baseMainnet: {
    chainId: 8453,
    name: "Base",
    rpcUrl: "https://mainnet.base.org",
    explorer: "https://basescan.org",
  },
  /** Polygon Mainnet */
  polygon: {
    chainId: 137,
    name: "Polygon",
    rpcUrl: "https://polygon-rpc.com",
    explorer: "https://polygonscan.com",
  },
} as const;

export type ChainConfigKey = keyof typeof CHAIN_CONFIGS;
