/** Resource limits to prevent abuse */
export const LIMITS = {
  MAX_WALLETS: 50,
  MAX_MEMO_HANDLERS: 20,
  MAX_DB_ROWS: 100_000,
  MAX_REGEX_LENGTH: 200,
  MAX_TEMPLATE_LENGTH: 500,
  DB_PRUNE_BATCH: 10_000,
  EVENT_QUEUE_MAX: 1000,
} as const;

export interface ChiaWatcherConfig {
  enabled: boolean;
  network: "mainnet" | "testnet11";
  wallets: string[];
  autoStart: boolean;
  notifyChannel?: string;
  notifyTo?: string;
  dbPath?: string;
  memoHandlers?: MemoHandler[];
  minAmountXch?: number;
  includeCATs?: boolean;
  pollIntervalMs?: number;
}

export interface MemoHandler {
  name: string;
  pattern: string; // regex string
  template: string; // notification template with {amount}, {memo}, {address}, {match1}, etc.
  enabled: boolean;
}

export interface CoinEvent {
  coinId: string;
  address: string;
  amount: number; // mojos
  amountXch: number;
  memoHex: string | null;
  memoDecoded: string | null;
  isCat: boolean;
  assetId?: string;
  createdHeight: number;
  spentHeight: number | null;
  network: string;
  timestamp: string;
  matchedHandler?: string;
}

export interface WatcherStatus {
  isRunning: boolean;
  startedAt: string | null;
  network: string;
  walletCount: number;
  wallets: string[];
  transactionCount: number;
  errorCount: number;
  peakHeight: number | null;
  peerAddr: string | null;
  uptime: number;
}

export const MAINNET_CONFIG = {
  introducer: "dns-introducer.chia.net",
  networkId: "mainnet",
  port: 8444,
  genesisChallenge: "ccd5bb71183532bff220ba46c268991a3ff07eb358e8255a65c30a2dce0e5fbb",
};

export const TESTNET_CONFIG = {
  introducer: "testnet11-introducer.chia.net",
  networkId: "testnet11",
  port: 58444,
  genesisChallenge: "37a90eb5185a9c4439a91ddc98bbadce7b4feba060d50116a067de66bf236615",
};
