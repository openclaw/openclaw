import { loadConfig } from "../src/config/config.js";
import { sendMessageTelegram } from "../extensions/telegram/src/send.js";

type CliArgs = {
  chatId: string;
  text: string;
  accountId?: string;
  textMode?: "markdown" | "html";
};

function printUsage(): never {
  console.error(
    "Usage: node --import tsx scripts/send-telegram-text.ts --chat <chatId> --text <message> [--account <accountId>] [--mode markdown|html]",
  );
  process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
  let chatId = "";
  let text = "";
  let accountId: string | undefined;
  let textMode: "markdown" | "html" | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--chat":
        chatId = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--text":
        text = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--account":
        accountId = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--mode": {
        const mode = argv[i + 1];
        if (mode === "markdown" || mode === "html") {
          textMode = mode;
        }
        i += 1;
        break;
      }
      default:
        break;
    }
  }

  if (!chatId || !text) {
    printUsage();
  }

  return { chatId, text, accountId, textMode };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig("C:/Users/dxhph/.openclaw/openclaw.json");
  const result = await sendMessageTelegram(args.chatId, args.text, {
    cfg,
    accountId: args.accountId ?? "default",
    textMode: args.textMode ?? "html",
    plainText: args.text,
  });
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
