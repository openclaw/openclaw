import type { Command } from "commander";
import type { BrokerProvider } from "./types.js";

// =============================================================================
// CLI Registration: openclaw trading <subcommand>
// =============================================================================

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export function registerTradingCli(params: {
  program: Command;
  ensureProvider: () => Promise<BrokerProvider>;
  logger: Logger;
}) {
  const { program, ensureProvider } = params;

  const root = program.command("trading").description("Trading portfolio & price utilities");

  root
    .command("status")
    .description("Show account status")
    .action(async () => {
      const provider = await ensureProvider();
      const account = await provider.getAccount();
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(account, null, 2));
    });

  root
    .command("portfolio")
    .description("Show all open positions")
    .action(async () => {
      const provider = await ensureProvider();
      const [account, positions] = await Promise.all([
        provider.getAccount(),
        provider.getPositions(),
      ]);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ account, positions }, null, 2));
    });

  root
    .command("price")
    .description("Get the latest price for a symbol")
    .argument("<symbol>", "Ticker symbol (e.g., AAPL, BTC/USD)")
    .action(async (symbol: string) => {
      const provider = await ensureProvider();
      const quote = await provider.getQuote(symbol);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(quote, null, 2));
    });
}
